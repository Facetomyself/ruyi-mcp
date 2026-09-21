/* Gecko agent snapshot/act helpers. Loaded into page.evaluate IIFE by the Bridge.
 * Live nodes stay in a page-side array (GC-safe enough for one observe/act cycle).
 * Act never searches by caller CSS/XPath; it only uses the stored node.
 */
function ruyiAgentSnapshot(maxNodes) {
  const limit = Math.max(1, Math.min(Number(maxNodes) || 250, 250));
  const truncatedReasons = [];
  const seen = new Set();
  const live = [];
  const nodes = [];

  if (document.querySelector("iframe")) {
    truncatedReasons.push("iframe");
  }
  if (document.querySelector("*") && (function hasOpenShadow(root) {
    const tree = root.querySelectorAll("*");
    for (let i = 0; i < tree.length; i += 1) {
      if (tree[i].shadowRoot) return true;
    }
    return false;
  })(document)) {
    truncatedReasons.push("shadow");
  }

  const selector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    "[role='menuitem']",
    "[contenteditable='true']",
    "iframe",
    "[draggable='true']",
  ].join(",");

  const candidates = Array.from(document.querySelectorAll(selector));
  const snapshotId = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const marker = {
    url: String(location.href || ""),
    title: String(document.title || ""),
    scrollX: Math.round(window.scrollX || 0),
    scrollY: Math.round(window.scrollY || 0),
  };

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width >= 2 && box.height >= 2;
  }

  function inViewport(el) {
    const box = el.getBoundingClientRect();
    return box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth;
  }

  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").trim().toLowerCase();
    if (explicit) return explicit;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "iframe") return "iframe";
    if (tag === "input") {
      const type = String(el.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    if (el.getAttribute("draggable") === "true") return "slider";
    return "generic";
  }

  function nameOf(el) {
    const bits = [
      el.getAttribute("aria-label"),
      el.getAttribute("name"),
      el.getAttribute("placeholder"),
      el.getAttribute("alt"),
      el.getAttribute("title"),
      el.value,
      (el.innerText || el.textContent || ""),
    ];
    const text = bits
      .map((part) => String(part || "").replace(/\s+/g, " ").trim())
      .find((part) => part.length > 0);
    return (text || "").slice(0, 80);
  }

  function opsOf(el, role) {
    const tag = (el.tagName || "").toLowerCase();
    const type = String(el.type || "").toLowerCase();
    const ops = [];
    if (role === "iframe") return ops;
    if (tag === "select" || role === "combobox" || role === "listbox") {
      ops.push("SELECT");
      return ops;
    }
    if (
      tag === "textarea"
      || el.isContentEditable
      || (tag === "input" && !["checkbox", "radio", "submit", "button", "reset", "image", "file", "hidden", "range"].includes(type))
      || role === "textbox"
      || role === "searchbox"
    ) {
      ops.push("TYPE_TEXT");
      ops.push("CLICK");
      return ops;
    }
    if (el.getAttribute("draggable") === "true" || type === "range") {
      ops.push("DRAG");
    }
    ops.push("CLICK");
    return ops;
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i];
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el) || !inViewport(el)) continue;
    if (el.disabled) continue;
    const role = roleOf(el);
    const ops = opsOf(el, role);
    if (live.length >= limit) {
      truncatedReasons.push("limit");
      break;
    }
    const index = live.length;
    const stamp = `${snapshotId}:${index}`;
    try {
      el.setAttribute("data-ruyi-agent", stamp);
    } catch (_err) {
      /* ignore non-element nodes */
    }
    live.push(el);
    const record = {
      index,
      role,
      tag: String(el.tagName || "").toLowerCase(),
      name: nameOf(el),
      ops,
      inViewport: true,
    };
    if ("value" in el && el.value != null && String(el.value).length) {
      record.value = String(el.value).slice(0, 80);
    }
    if (typeof el.checked === "boolean") {
      record.checked = el.checked;
    }
    if (el.getAttribute("aria-expanded")) {
      record.expanded = el.getAttribute("aria-expanded") === "true";
    }
    nodes.push(record);
  }

  const unique = truncatedReasons.filter((item, idx, arr) => arr.indexOf(item) === idx);
  window.__ruyiAgentSnapshot = {
    snapshotId,
    marker,
    live,
  };

  return {
    snapshotId,
    url: marker.url,
    title: marker.title,
    scroll: { x: marker.scrollX, y: marker.scrollY },
    truncated: unique.length > 0,
    truncatedReasons: unique,
    nodeCount: nodes.length,
    nodes,
  };
}

function ruyiAgentAct(payload) {
  const store = window.__ruyiAgentSnapshot;
  const snapshotId = payload && payload.snapshotId;
  const index = payload && payload.index;
  const op = payload && payload.op;
  if (!store || !store.snapshotId) {
    return { ok: false, miss: true, reason: "no_snapshot", retried: false };
  }
  if (snapshotId && store.snapshotId !== snapshotId) {
    return { ok: false, miss: true, reason: "stale_snapshot", retried: false };
  }
  const marker = {
    url: String(location.href || ""),
    title: String(document.title || ""),
    scrollX: Math.round(window.scrollX || 0),
    scrollY: Math.round(window.scrollY || 0),
  };
  if (store.marker && store.marker.url !== marker.url) {
    return { ok: false, miss: true, reason: "stale_marker", retried: false };
  }
  if (
    store.marker
    && Math.abs((store.marker.scrollY || 0) - marker.scrollY) > 80
  ) {
    return { ok: false, miss: true, reason: "stale_marker", retried: false };
  }

  if (op === "SELECT" || op === "CLICK" || op === "TYPE_TEXT" || op === "DRAG") {
    if (typeof index !== "number" || index < 0 || index >= store.live.length) {
      return { ok: false, miss: true, reason: "gone", retried: false };
    }
    const el = store.live[index];
    if (!el || !el.isConnected) {
      return { ok: false, miss: true, reason: "detached", retried: false };
    }
    const box = el.getBoundingClientRect();
    if (!box || box.width < 1 || box.height < 1) {
      return { ok: false, miss: true, reason: "gone", retried: false };
    }
    const x = Math.round(box.left + Math.min(Math.max(box.width / 2, 1), box.width - 1));
    const y = Math.round(box.top + Math.min(Math.max(box.height / 2, 1), box.height - 1));
    const top = document.elementFromPoint(x, y);
    if (op === "CLICK" || op === "TYPE_TEXT" || op === "DRAG") {
      if (!top || !(el === top || el.contains(top) || top.contains(el))) {
        return { ok: false, miss: true, reason: "occluded", retried: false };
      }
    }
    const stamp = `${store.snapshotId}:${index}`;
    if (op === "SELECT") {
      if (String(el.tagName || "").toLowerCase() !== "select") {
        return { ok: false, miss: true, reason: "not_select", retried: false };
      }
      const wanted = String((payload && payload.text) || "");
      let matched = false;
      for (let i = 0; i < el.options.length; i += 1) {
        const option = el.options[i];
        if (option.value === wanted || String(option.text).trim() === wanted) {
          el.value = option.value;
          matched = true;
          break;
        }
      }
      if (!matched) {
        return { ok: false, miss: true, reason: "option_not_found", retried: false };
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, op: "SELECT", value: el.value, stamp, retried: false };
    }
    if (op === "TYPE_TEXT") {
      try {
        el.focus();
      } catch (_err) {
        return { ok: false, miss: true, reason: "gone", retried: false };
      }
    }
    return {
      ok: true,
      op,
      x,
      y,
      stamp,
      tag: String(el.tagName || "").toLowerCase(),
      retried: false,
    };
  }

  return { ok: true, op, retried: false };
}
