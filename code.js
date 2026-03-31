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

// ─── Frame traversal ──────────────────────────────────────────────────────────

// Returns the top-level frame/component ancestor of a node, or null if the node
// sits directly on the page or has no bounding box.
function getTopLevelFrame(node) {
  var cur = node;
  while (cur.parent && cur.parent.type !== "PAGE" && cur.parent.type !== "DOCUMENT") {
    cur = cur.parent;
  }
  if (cur === node || !cur.absoluteBoundingBox) return null;
  return cur;
}

// ─── Pixel sampling ───────────────────────────────────────────────────────────

// Export `frame` with all its text nodes hidden, then ask the UI to sample
// pixel colors at each candidate's center. Returns an array of { r, g, b }.
async function processFrameGroup(frame, candidates) {
  var frameBounds = frame.absoluteBoundingBox;

  // Hide all text in the frame so we sample pure background pixels
  var allText = frame.findAll(function (n) { return n.type === "TEXT"; });
  var savedVisibility = allText.map(function (n) { return n.visible; });
  allText.forEach(function (n) { n.visible = false; });

  var imageBytes;
  try {
    imageBytes = await frame.exportAsync({ format: "PNG", scale: 1 });
  } finally {
    allText.forEach(function (n, i) { n.visible = savedVisibility[i]; });
  }

  // Build a sample point at the center of each candidate's bounding box
  var points = candidates.map(function (c) {
    var b = c.node.absoluteBoundingBox;
    if (!b) return { x: 0, y: 0 };
    return {
      x: Math.round(b.x - frameBounds.x + b.width / 2),
      y: Math.round(b.y - frameBounds.y + b.height / 2),
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
    if (isEffectivelyHidden(node)) { checked++; continue; }
    if (node.fontSize === figma.mixed)        { skipped++; continue; }
    var fgResult = getTextColor(node);
    if (fgResult === null)   { checked++; continue; } // no fill → decoration
    if (fgResult === "skip") { skipped++; continue; } // gradient/image fill
    candidates.push({ node: node, fgResult: fgResult });
  }

  // Group candidates by their top-level frame so we export each frame once
  var frameGroups = {};
  var noFrameCandidates = [];
  for (var j = 0; j < candidates.length; j++) {
    var c = candidates[j];
    var frame = getTopLevelFrame(c.node);
    if (!frame) { noFrameCandidates.push(c); continue; }
    if (!frameGroups[frame.id]) frameGroups[frame.id] = { frame: frame, candidates: [] };
    frameGroups[frame.id].candidates.push(c);
  }

  // Process each frame group: hide text, export once, sample all positions
  var groupIds = Object.keys(frameGroups);
  for (var k = 0; k < groupIds.length; k++) {
    var group = frameGroups[groupIds[k]];
    var results = await processFrameGroup(group.frame, group.candidates);
    for (var m = 0; m < results.length; m++) {
      checked++;
      if (results[m] !== null) issues.push(results[m]);
    }
  }

  // Nodes not inside any frame: assume white canvas background
  for (var n = 0; n < noFrameCandidates.length; n++) {
    var nc = noFrameCandidates[n];
    checked++;
    var r = computeContrastResult(nc.node, nc.fgResult, { r: 1, g: 1, b: 1 });
    if (r !== null) issues.push(r);
  }

  return { issues: issues, checked: checked, skipped: skipped };
}
