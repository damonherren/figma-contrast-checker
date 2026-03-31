// Figma Contrast Checker — main plugin code
// Scans TEXT nodes for WCAG AA contrast failures (4.5:1 normal, 3:1 large text)

figma.showUI(__html__, { width: 520, height: 640, title: "Contrast Checker" });

var pendingPixelResolve = null;

figma.ui.onmessage = async function (msg) {
  if (msg.type === "scan") {
    try {
      var r = await scan();
      figma.ui.postMessage({ type: "results", issues: r.issues, checked: r.checked, skipped: r.skipped });
    } catch (err) {
      figma.ui.postMessage({ type: "error", message: String(err) });
    }
  } else if (msg.type === "pixelSampleResults") {
    if (pendingPixelResolve) {
      pendingPixelResolve(msg.colors);
      pendingPixelResolve = null;
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
// null (no fills → treat as decoration), or "skip" (non-solid fill).
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

// ─── Background node detection ────────────────────────────────────────────────

// For text with no filled ancestor (sitting directly on the canvas), find the
// nearest overlapping page-level node below it in z-order.
// In the Figma API children[] is back-to-front (index 0 = furthest back).
function getPageBackgroundNode(textNode) {
  var textBounds = textNode.absoluteBoundingBox;
  if (!textBounds) return null;
  var cx = textBounds.x + textBounds.width / 2;
  var cy = textBounds.y + textBounds.height / 2;
  var children = figma.currentPage.children;

  // Find where this text node sits in the page's child list (-1 if it's nested).
  var selfIdx = -1;
  for (var i = 0; i < children.length; i++) {
    if (children[i] === textNode) { selfIdx = i; break; }
  }

  // Search backwards from the node below the text (lower z-order = smaller index).
  var limit = selfIdx >= 0 ? selfIdx : children.length;
  for (var si = limit - 1; si >= 0; si--) {
    var sib = children[si];
    if (!sib.visible) continue;
    var bb = sib.absoluteBoundingBox;
    if (!bb) continue;
    if (cx >= bb.x && cx <= bb.x + bb.width && cy >= bb.y && cy <= bb.y + bb.height) {
      return sib;
    }
  }
  return null; // nothing below — white canvas
}

// Returns the node to export for background pixel sampling.
//
// Strategy: walk up from the text node and return the nearest ancestor that
// (a) has at least one visible fill, AND
// (b) whose absoluteBoundingBox actually contains the text center.
//
// Requiring (b) ensures the sampling coordinates are always within the exported
// image — avoiding the clamping artefact where overflow text gets the edge pixel.
//
// If no such ancestor exists (text is directly on the canvas or overflows every
// filled frame), fall back to the nearest overlapping page-level sibling.
function getBackgroundNode(textNode) {
  var textBounds = textNode.absoluteBoundingBox;
  if (!textBounds) return null;
  var cx = textBounds.x + textBounds.width / 2;
  var cy = textBounds.y + textBounds.height / 2;

  var cur = textNode.parent;
  while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
    var bb = cur.absoluteBoundingBox;
    if (bb && cx >= bb.x && cx <= bb.x + bb.width && cy >= bb.y && cy <= bb.y + bb.height) {
      var f = cur.fills;
      if (f && f !== figma.mixed && Array.isArray(f)) {
        for (var i = f.length - 1; i >= 0; i--) {
          if (f[i].visible !== false) return cur;
        }
      }
    }
    cur = cur.parent;
  }

  return getPageBackgroundNode(textNode);
}

// ─── Pixel sampling ───────────────────────────────────────────────────────────

// Export `bgNode`, hiding any text that is a descendant of it, then ask the UI
// to sample pixel colors at each candidate text node's center.
async function processGroup(bgNode, candidates) {
  var bgBounds = bgNode.absoluteBoundingBox;

  // Hide descendant text so we sample pure background pixels.
  // (Text nodes that are siblings/ancestors of bgNode don't need hiding.)
  var textDescendants = bgNode.findAll ? bgNode.findAll(function (n) { return n.type === "TEXT"; }) : [];
  var savedVis = textDescendants.map(function (n) { return n.visible; });
  textDescendants.forEach(function (n) { n.visible = false; });

  var imageBytes;
  try {
    imageBytes = await bgNode.exportAsync({ format: "PNG", scale: 1 });
  } finally {
    textDescendants.forEach(function (n, i) { n.visible = savedVis[i]; });
  }

  var points = candidates.map(function (c) {
    var b = c.node.absoluteBoundingBox;
    if (!b) return { x: 0, y: 0 };
    return {
      x: Math.round(b.x - bgBounds.x + b.width / 2),
      y: Math.round(b.y - bgBounds.y + b.height / 2),
    };
  });

  var bgColors = await requestPixelSamples(imageBytes, points);

  return candidates.map(function (c, i) {
    return computeContrastResult(c.node, c.fgResult, bgColors[i]);
  });
}

function requestPixelSamples(imageBytes, points) {
  return new Promise(function (resolve) {
    pendingPixelResolve = resolve;
    figma.ui.postMessage({
      type: "pixelSamples",
      imageData: Array.from(imageBytes),
      points: points,
    });
  });
}

// ─── Contrast computation ─────────────────────────────────────────────────────

function computeContrastResult(node, fgResult, bg) {
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

// Returns true if the node or any ancestor up to (but not including) the page is hidden.
function isEffectivelyHidden(node) {
  var n = node;
  while (n && n.type !== "PAGE" && n.type !== "DOCUMENT") {
    if (!n.visible || n.opacity === 0) return true;
    n = n.parent;
  }
  return false;
}

async function scan() {
  var issues = [], checked = 0, skipped = 0;
  var allTextNodes = figma.currentPage.findAll(function (n) { return n.type === "TEXT"; });

  // First pass: filter nodes and resolve foreground colors (all synchronous)
  var candidates = [];
  for (var i = 0; i < allTextNodes.length; i++) {
    var node = allTextNodes[i];
    if (isEffectivelyHidden(node))       { checked++; continue; }
    if (node.fontSize === figma.mixed)   { skipped++; continue; }
    var fgResult = getTextColor(node);
    if (fgResult === null)               { checked++; continue; } // no fill → decoration
    if (fgResult === "skip")             { skipped++; continue; } // gradient/image fill
    candidates.push({ node: node, fgResult: fgResult });
  }

  // Group candidates by background node so each background is exported only once.
  var bgGroups = {};
  var whiteCandidates = []; // no background found → assume white canvas
  for (var j = 0; j < candidates.length; j++) {
    var c = candidates[j];
    var bgNode = getBackgroundNode(c.node);
    if (!bgNode) { whiteCandidates.push(c); continue; }
    if (!bgGroups[bgNode.id]) bgGroups[bgNode.id] = { bgNode: bgNode, candidates: [] };
    bgGroups[bgNode.id].candidates.push(c);
  }

  // Process each background group: export once, sample all positions
  var groupIds = Object.keys(bgGroups);
  for (var k = 0; k < groupIds.length; k++) {
    var group = bgGroups[groupIds[k]];
    var results = await processGroup(group.bgNode, group.candidates);
    for (var m = 0; m < results.length; m++) {
      checked++;
      if (results[m] !== null) issues.push(results[m]);
    }
  }

  // Fallback: text with no detectable background → assume white canvas
  for (var n = 0; n < whiteCandidates.length; n++) {
    var wc = whiteCandidates[n];
    checked++;
    var r = computeContrastResult(wc.node, wc.fgResult, { r: 1, g: 1, b: 1 });
    if (r !== null) issues.push(r);
  }

  return { issues: issues, checked: checked, skipped: skipped };
}
