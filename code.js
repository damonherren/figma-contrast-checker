// Figma Contrast Checker — main plugin code
// Scans TEXT nodes for WCAG AA contrast failures (4.5:1 normal, 3:1 large text)

figma.showUI(__html__, { width: 520, height: 640, title: "Contrast Checker" });

figma.ui.onmessage = function (msg) {
  if (msg.type === "scan") {
    try {
      var r = scan();
      figma.ui.postMessage({ type: "results", issues: r.issues, checked: r.checked, skipped: r.skipped });
    } catch (err) {
      figma.ui.postMessage({ type: "error", message: String(err) });
    }
  } else if (msg.type === "select") {
    var node = figma.getNodeById(msg.nodeId);
    if (node && node.type !== "DOCUMENT" && node.type !== "PAGE") {
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
    }
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};

// ─── WCAG math ────────────────────────────────────────────────────────────────

function linearize(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(r, g, b) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(l1, l2) {
  var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// Porter-Duff "over" composite: fg at alpha over bg
function composite(fg, alpha, bg) {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toHex(c) {
  function ch(v) { return Math.round(v * 255).toString(16).padStart(2, "0"); }
  return "#" + ch(c.r) + ch(c.g) + ch(c.b);
}

// WCAG "bold" = weight 700+. Excludes SemiBold/DemiBold (600).
function isBoldWeight(style) {
  if (!style) return false;
  var s = style.toLowerCase();
  if (/semi.?bold|demi.?bold/.test(s)) return false;
  return /bold|black|heavy/.test(s);
}

// WCAG large text: 18pt (24px) regular, or 14pt (≈18.67px) bold
function isLargeText(fontSize, fontStyle) {
  if (fontSize >= 24) return true;
  if (fontSize >= 18.67 && isBoldWeight(fontStyle)) return true;
  return false;
}

function textPreview(node) {
  var t = (node.characters || "").replace(/\n/g, " ").trim();
  if (!t) return "[empty]";
  return t.length > 55 ? t.slice(0, 55) + "…" : t;
}

function breadcrumb(node) {
  var parts = [], n = node, d = 0;
  while (n && n.type !== "PAGE" && d++ < 4) { parts.unshift(n.name); n = n.parent; }
  if (n && n.type !== "PAGE") parts.unshift("…");
  return parts.join(" › ");
}

// ─── Color extraction ─────────────────────────────────────────────────────────

// Returns { color, alpha } for the topmost visible solid fill on a text node,
// or null (no fills → treat as decoration), or the string "skip" (non-solid fill).
function getTextColor(node) {
  if (!("fills" in node) || node.fills === figma.mixed || !Array.isArray(node.fills)) return null;
  var nodeAlpha = node.opacity !== undefined ? node.opacity : 1;
  for (var i = node.fills.length - 1; i >= 0; i--) {
    var f = node.fills[i];
    if (f.visible === false) continue;
    if (f.type !== "SOLID") return "skip"; // gradient/image text fill
    return { color: f.color, alpha: (f.opacity !== undefined ? f.opacity : 1) * nodeAlpha };
  }
  return null;
}

// Determines the effective background color behind a text node by walking the
// full ancestor chain and, at each level, collecting:
//   1. The ancestor frame's own solid fills
//   2. Any sibling layers that are stacked BELOW the text (lower z-index) and
//      whose bounds cover the text — the most common real-world case
// All collected layers are composited outermost→innermost over a white canvas.
// Returns { color } or "skip" if a non-solid fill is encountered.
function getBackgroundColor(textNode) {
  var textBounds = textNode.absoluteBoundingBox;

  // Build ancestor chain outermost-first, tracking which child at each level
  // is on the path toward the text node.
  var ancestors = [], childOnPath = [];
  var cur = textNode, anc = textNode.parent;
  while (anc && anc.type !== "PAGE" && anc.type !== "DOCUMENT") {
    ancestors.unshift(anc);
    childOnPath.unshift(cur);
    cur = anc;
    anc = anc.parent;
  }

  // Collect background paint layers in visual stacking order (bottom → top)
  var layers = [];

  for (var ai = 0; ai < ancestors.length; ai++) {
    var a = ancestors[ai];
    var aAlpha = a.opacity !== undefined ? a.opacity : 1;
    var child = childOnPath[ai];

    // 1. The ancestor frame's own fills sit behind everything inside it
    if ("fills" in a && a.fills !== figma.mixed && Array.isArray(a.fills)) {
      for (var fi = 0; fi < a.fills.length; fi++) {
        var f = a.fills[fi];
        if (f.visible === false) continue;
        if (f.type !== "SOLID") return "skip";
        layers.push({ color: f.color, alpha: (f.opacity !== undefined ? f.opacity : 1) * aAlpha });
      }
    }

    // 2. Sibling layers below `child` that cover the text bounds.
    //    In Figma children[] is ordered bottom→top (index 0 = lowest layer).
    if (a.children) {
      var childIdx = a.children.indexOf(child);
      for (var si = 0; si < childIdx; si++) {
        var sib = a.children[si];
        if (!sib.visible) continue;
        if (!("fills" in sib) || sib.fills === figma.mixed || !Array.isArray(sib.fills) || sib.fills.length === 0) continue;
        if (!covers(sib.absoluteBoundingBox, textBounds)) continue;

        var sAlpha = sib.opacity !== undefined ? sib.opacity : 1;
        for (var sfi = 0; sfi < sib.fills.length; sfi++) {
          var sf = sib.fills[sfi];
          if (sf.visible === false) continue;
          if (sf.type !== "SOLID") return "skip";
          layers.push({ color: sf.color, alpha: (sf.opacity !== undefined ? sf.opacity : 1) * sAlpha });
        }
      }
    }
  }

  // Composite all collected layers over the white canvas
  var bg = { r: 1, g: 1, b: 1 };
  for (var li = 0; li < layers.length; li++) {
    bg = composite(layers[li].color, layers[li].alpha, bg);
  }

  return { color: bg };
}

// Returns true if `container` bounds fully cover `target` bounds (±2px tolerance).
function covers(container, target) {
  if (!target) return false;
  if (!container) return true;
  var t = 2;
  return container.x     <= target.x + t &&
         container.y     <= target.y + t &&
         container.x + container.width  >= target.x + target.width  - t &&
         container.y + container.height >= target.y + target.height - t;
}

// ─── Per-node check ───────────────────────────────────────────────────────────

function checkTextNode(node) {
  // WCAG exemptions: invisible / zero-opacity nodes
  if (!node.visible || node.opacity === 0) return null;

  // Skip nodes with per-character font size variance (too ambiguous to check as a unit)
  if (node.fontSize === figma.mixed) return "skip";

  var fgResult = getTextColor(node);
  if (fgResult === null) return null;   // no fills → decoration
  if (fgResult === "skip") return "skip";

  var bgResult = getBackgroundColor(node);
  if (bgResult === "skip") return "skip";

  var bg = bgResult.color;

  // If text fill is semi-transparent, composite it over the background first
  var effectiveFg = fgResult.alpha < 0.999
    ? composite(fgResult.color, fgResult.alpha, bg)
    : fgResult.color;

  var ratio = contrastRatio(
    luminance(effectiveFg.r, effectiveFg.g, effectiveFg.b),
    luminance(bg.r, bg.g, bg.b)
  );

  var fontStyle = node.fontName !== figma.mixed ? node.fontName.style : null;
  var large = isLargeText(node.fontSize, fontStyle);
  var required = large ? 3.0 : 4.5;

  if (ratio >= required) return null; // passes

  return {
    nodeId: node.id,
    nodePath: breadcrumb(node),
    textPreview: textPreview(node),
    fgHex: toHex(effectiveFg),
    bgHex: toHex(bg),
    ratio: Math.round(ratio * 100) / 100,
    required: required,
    large: large,
    fontSize: node.fontSize,
    fontStyle: fontStyle,
  };
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

function scan() {
  var issues = [], checked = 0, skipped = 0;
  var nodes = figma.currentPage.findAll(function (n) { return n.type === "TEXT"; });
  for (var i = 0; i < nodes.length; i++) {
    var r = checkTextNode(nodes[i]);
    if (r === null)   { checked++; }
    else if (r === "skip") { skipped++; }
    else              { checked++; issues.push(r); }
  }
  return { issues: issues, checked: checked, skipped: skipped };
}
