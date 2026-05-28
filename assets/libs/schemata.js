/**
 * Schemata Renderer - SVG diagram generator for markdown code blocks
 *
 * Usage:
 *   // Render all schemata elements on the page
 *   Schemata.renderAll(containerElement);
 *
 *   // Parse and render a single source string
 *   const svg = Schemata.render(sourceText);
 *
 *   // Parse source text into structured data
 *   const parsed = Schemata.parse(sourceText);
 *
 * Supported diagram types:
 *   - matrix NxM  (e.g., "matrix 2x2", "matrix 3x2")
 *   - flow        (horizontal flow: A → B → C)
 *   - cycle       (circular cycle: A → B → C → A)
 *   - bmc         (Business Model Canvas: 9-block strategic layout)
 *   - mandara     (Mandara chart: 9x9 goal-decomposition grid)
 *   - fishbone    (Ishikawa/cause-and-effect diagram, options: "vertical")
 *
 * Notation:
 *   ```schemata
 *   matrix 2x2
 *   title: SWOT Analysis
 *
 *   [Strengths / 強み | c-teal]
 *   - Item one
 *   - Item two
 *
 *   [Weaknesses | c-coral]
 *   - Item
 *   ```
 */
(function (global) {
    'use strict';

    // ===== Color Palette (light / dark) =====
    var PALETTE = {
        light: {
            'c-teal':   { fill:'#E1F5EE', stroke:'#0F6E56', title:'#085041', bullet:'#1D9E75' },
            'c-coral':  { fill:'#FAECE7', stroke:'#993C1D', title:'#712B13', bullet:'#D85A30' },
            'c-blue':   { fill:'#E6F1FB', stroke:'#185FA5', title:'#0C447C', bullet:'#378ADD' },
            'c-amber':  { fill:'#FAEEDA', stroke:'#854F0B', title:'#633806', bullet:'#BA7517' },
            'c-purple': { fill:'#EEEDFE', stroke:'#534AB7', title:'#3C3489', bullet:'#7F77DD' },
            'c-green':  { fill:'#EAF3DE', stroke:'#3B6D11', title:'#27500A', bullet:'#639922' },
            'c-pink':   { fill:'#FBEAF0', stroke:'#993556', title:'#72243E', bullet:'#D4537E' },
            'c-gray':   { fill:'#F1EFE8', stroke:'#5F5E5A', title:'#444441', bullet:'#888780' }
        },
        dark: {
            'c-teal':   { fill:'#04342C', stroke:'#5DCAA5', title:'#9FE1CB', bullet:'#1D9E75' },
            'c-coral':  { fill:'#4A1B0C', stroke:'#F0997B', title:'#F5C4B3', bullet:'#D85A30' },
            'c-blue':   { fill:'#042C53', stroke:'#85B7EB', title:'#B5D4F4', bullet:'#378ADD' },
            'c-amber':  { fill:'#412402', stroke:'#EF9F27', title:'#FAC775', bullet:'#BA7517' },
            'c-purple': { fill:'#26215C', stroke:'#AFA9EC', title:'#CECBF6', bullet:'#7F77DD' },
            'c-green':  { fill:'#173404', stroke:'#97C459', title:'#C0DD97', bullet:'#639922' },
            'c-pink':   { fill:'#4B1528', stroke:'#ED93B1', title:'#F4C0D1', bullet:'#D4537E' },
            'c-gray':   { fill:'#2C2C2A', stroke:'#B4B2A9', title:'#D3D1C7', bullet:'#888780' }
        }
    };

    // ===== Renderer dispatch table =====
    var RENDERERS = {
        matrix:   renderMatrix,
        flow:     renderFlow,
        cycle:    renderCycle,
        bmc:      renderBmc,
        mandara:  renderMandara,
        fishbone: renderFishbone
    };

    // Color keys for auto-assignment (used by fishbone)
    var COLOR_KEYS = ['c-teal', 'c-coral', 'c-blue', 'c-amber', 'c-purple', 'c-green', 'c-pink', 'c-gray'];

    // Unique instance counter to avoid clip-path ID collisions across multiple SVGs
    var _instanceId = 0;

    // ===== Utility functions =====

    function escapeXml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isDark() {
        // Follow the app theme (`body.dark-mode`, set by the M-key style cycle)
        // rather than the OS `prefers-color-scheme`, so that the Schemata palette
        // matches the surrounding preview and stays in sync with Mermaid's
        // detection in assets/index.html.
        return !!(global.document && global.document.body && global.document.body.classList.contains('dark-mode'));
    }

    function getColors(colorKey) {
        var mode = isDark() ? 'dark' : 'light';
        return PALETTE[mode][colorKey] || PALETTE[mode]['c-gray'];
    }

    /**
     * Measure approximate display width of text.
     * CJK characters count as 1.8 units; others as 1.
     */
    function measureTextWidth(text) {
        var width = 0;
        for (var i = 0; i < text.length; i++) {
            var code = text.codePointAt(i);
            if (code > 0xFFFF) i++; // skip surrogate pair
            if ((code >= 0x3000 && code <= 0x9FFF) ||
                (code >= 0xF900 && code <= 0xFAFF) ||
                (code >= 0xFF00 && code <= 0xFFEF)) {
                width += 1.8;
            } else {
                width += 1;
            }
        }
        return width;
    }

    /**
     * Wrap text to fit within maxWidth character-equivalents.
     */
    function wrapText(text, maxWidth) {
        maxWidth = maxWidth || 22;
        var result = [];
        var currentLine = '';
        var currentWidth = 0;
        for (var i = 0; i < text.length; i++) {
            var char = text[i];
            var code = text.codePointAt(i);
            if (code > 0xFFFF) { char = text[i] + text[i + 1]; i++; }
            var charWidth = measureTextWidth(char);
            if (currentWidth + charWidth > maxWidth && currentLine.length > 0) {
                result.push(currentLine);
                currentLine = char;
                currentWidth = charWidth;
            } else {
                currentLine += char;
                currentWidth += charWidth;
            }
        }
        if (currentLine) result.push(currentLine);
        return result;
    }

    // ===== Shared cell rendering helpers =====

    /**
     * Render cell background rect + header background (rounded top, flat bottom).
     * @returns {string} SVG fragment
     */
    function renderCellBox(uid, prefix, i, x, y, w, h, colors, cornerR, headerH) {
        var svg = '';
        // Cell background
        svg += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + cornerR + '" ry="' + cornerR + '" fill="' + colors.fill + '" stroke="' + colors.stroke + '" stroke-width="1.5"/>';
        // Header background (rounded top, flat bottom via clip-path)
        svg += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + (headerH + cornerR) + '" fill="' + colors.stroke + '" clip-path="url(#' + prefix + '-' + uid + '-' + i + ')"/>';
        svg += '<rect x="' + x + '" y="' + (y + cornerR) + '" width="' + w + '" height="' + (headerH - cornerR) + '" fill="' + colors.stroke + '"/>';
        return svg;
    }

    /**
     * Render header text (single-line or two-line) centered in the header area.
     * @returns {string} SVG fragment
     */
    function renderHeaderText(x, y, w, headerH, cell) {
        var hx = x + w / 2;
        if (cell.labelLine2) {
            return '<text x="' + hx + '" y="' + (y + headerH / 2) + '" text-anchor="middle" fill="#FFFFFF">'
                + '<tspan x="' + hx + '" dy="-0.3em" font-size="13" font-weight="bold">' + escapeXml(cell.labelLine1) + '</tspan>'
                + '<tspan x="' + hx + '" dy="1.2em" font-size="11">' + escapeXml(cell.labelLine2) + '</tspan>'
                + '</text>';
        }
        return '<text x="' + hx + '" y="' + (y + headerH / 2 + 5) + '" text-anchor="middle" font-size="13" font-weight="bold" fill="#FFFFFF">' + escapeXml(cell.labelLine1) + '</text>';
    }

    /**
     * Render bullet items inside a cell.
     * @returns {string} SVG fragment
     */
    function renderBullets(x, y, w, h, headerH, pad, bulletLineH, maxCharWidth, cell, colors) {
        var svg = '';
        var bulletY = y + headerH + pad;
        for (var b = 0; b < cell.bullets.length; b++) {
            if (bulletY + bulletLineH > y + h - 4) break;
            var wrappedLines = wrapText(cell.bullets[b], maxCharWidth);
            for (var li = 0; li < wrappedLines.length; li++) {
                if (bulletY + bulletLineH > y + h - 4) break;
                var bulletX = x + pad;
                if (li === 0) {
                    svg += '<circle cx="' + (bulletX + 4) + '" cy="' + (bulletY + 6) + '" r="2.5" fill="' + colors.bullet + '"/>';
                }
                svg += '<text x="' + (bulletX + 14) + '" y="' + (bulletY + 10) + '" font-size="12" fill="' + colors.title + '">' + escapeXml(wrappedLines[li]) + '</text>';
                bulletY += bulletLineH;
            }
        }
        return svg;
    }

    // ===== Parser =====

    /**
     * Parse schemata source text into a structured object.
     *
     * @param {string} source - Raw code block content
     * @returns {{ type: string, options: string, title: string, cells: Array }}
     */
    function parse(source) {
        var lines = source.trim().split('\n');
        var lineIndex = 0;

        // Line 1: type and options (e.g., "matrix 2x2", "flow horizontal")
        var typeLine = (lines[lineIndex++] || '').trim();
        var typeMatch = typeLine.match(/^(\w+)\s*(.*)?$/);
        var type = typeMatch ? typeMatch[1] : 'matrix';
        var options = typeMatch ? (typeMatch[2] || '').trim() : '';

        // Optional directives (title:, scale:) — accept in any order, interspersed with blank lines
        var title = '';
        var scale = 1;
        while (lineIndex < lines.length) {
            var directive = lines[lineIndex].trim();
            if (directive === '') { lineIndex++; continue; }
            if (directive.indexOf('title:') === 0) {
                title = directive.replace(/^title:\s*/, '');
                lineIndex++;
            } else if (directive.indexOf('scale:') === 0) {
                var s = parseFloat(directive.replace(/^scale:\s*/, ''));
                if (!isNaN(s) && s > 0) scale = s;
                lineIndex++;
            } else {
                break;
            }
        }

        // Parse cells: "- Label / SubLabel #color" followed by indented "  - bullet" items
        var cells = [];
        var currentCell = null;

        while (lineIndex < lines.length) {
            var raw = lines[lineIndex];
            var line = raw.trim();
            // Top-level item (no indent): "- Label / SubLabel #color"
            var isTopLevel = raw.match(/^-\s/);
            var topMatch = isTopLevel ? line.match(/^-\s+(.+?)(?:\s+#(\S+))?$/) : null;
            if (topMatch) {
                if (currentCell) cells.push(currentCell);
                var rawLabel = topMatch[1].trim();
                var colorKey = topMatch[2] ? topMatch[2].trim() : 'c-teal';
                var labelParts = rawLabel.split(/\s*\/\s*/);
                currentCell = {
                    labelLine1: labelParts[0],
                    labelLine2: labelParts.length > 1 ? labelParts[1] : null,
                    colorKey: colorKey,
                    bullets: []
                };
            } else if (raw.match(/^\s{2,}-\s/) && currentCell) {
                // Sub-item (indented): "  - bullet text"
                currentCell.bullets.push(line.substring(2));
            }
            lineIndex++;
        }
        if (currentCell) cells.push(currentCell);

        return { type: type, options: options, title: title, scale: scale, cells: cells };
    }

    /**
     * Apply a display scale factor to the rendered SVG by adjusting the root
     * <svg> element's width/height attributes. When scale > 1, also strips
     * `max-width:100%` from the inline style so the diagram can grow beyond
     * its container (becoming horizontally scrollable if the page allows).
     */
    function applyScale(svg, scale) {
        if (!scale || scale === 1) return svg;
        return svg.replace(/^<svg[^>]*>/, function (tag) {
            var out = tag
                .replace(/\swidth="([\d.]+)"/, function (_, w) {
                    return ' width="' + (parseFloat(w) * scale).toFixed(2) + '"';
                })
                .replace(/\sheight="([\d.]+)"/, function (_, h) {
                    return ' height="' + (parseFloat(h) * scale).toFixed(2) + '"';
                });
            if (scale > 1) {
                out = out.replace(/max-width:\s*100%\s*;?/, '');
            }
            return out;
        });
    }

    // ===== Matrix Renderer =====

    function renderMatrix(parsed) {
        var uid = _instanceId++;
        // Parse grid dimensions from options (e.g., "2x2", "3x2")
        var cols = 2, rows = 2;
        var gridMatch = (parsed.options || '').match(/(\d+)x(\d+)/);
        if (gridMatch) {
            cols = parseInt(gridMatch[1], 10);
            rows = parseInt(gridMatch[2], 10);
        }
        var title = parsed.title;
        var cells = parsed.cells;

        var CELL_W = 265;
        var CELL_H = 170;
        var GAP = 6;
        var PAD = 16;
        var TITLE_H = title ? 36 : 0;
        var HEADER_H = 36;
        var BULLET_LINE_H = 20;
        var CORNER_R = 8;

        var totalW = cols * CELL_W + (cols - 1) * GAP;
        var totalH = TITLE_H + rows * CELL_H + (rows - 1) * GAP;
        var titleColor = isDark() ? '#e0e0e0' : '#333333';
        var maxCells = Math.min(cells.length, cols * rows);

        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" style="max-width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">';

        // Defs for clip paths
        svg += '<defs>';
        for (var i = 0; i < maxCells; i++) {
            var col = i % cols;
            var row = Math.floor(i / cols);
            var x = col * (CELL_W + GAP);
            var y = TITLE_H + row * (CELL_H + GAP);
            svg += '<clipPath id="sa-clip-' + uid + '-' + i + '"><rect x="' + x + '" y="' + y + '" width="' + CELL_W + '" height="' + HEADER_H + '" rx="' + CORNER_R + '" ry="' + CORNER_R + '"/></clipPath>';
        }
        svg += '</defs>';

        // Title
        if (title) {
            svg += '<text x="' + (totalW / 2) + '" y="' + (TITLE_H / 2 + 6) + '" text-anchor="middle" font-size="16" font-weight="bold" fill="' + titleColor + '">' + escapeXml(title) + '</text>';
        }

        // Render cells
        for (var i = 0; i < maxCells; i++) {
            var cell = cells[i];
            var col = i % cols;
            var row = Math.floor(i / cols);
            var x = col * (CELL_W + GAP);
            var y = TITLE_H + row * (CELL_H + GAP);
            var colors = getColors(cell.colorKey);

            svg += renderCellBox(uid, 'sa-clip', i, x, y, CELL_W, CELL_H, colors, CORNER_R, HEADER_H);
            svg += renderHeaderText(x, y, CELL_W, HEADER_H, cell);
            svg += renderBullets(x, y, CELL_W, CELL_H, HEADER_H, PAD, BULLET_LINE_H, 22, cell, colors);
        }

        svg += '</svg>';
        return svg;
    }

    // ===== Flow Renderer =====

    function renderFlow(parsed) {
        var uid = _instanceId++;
        var title = parsed.title;
        var cells = parsed.cells;
        var N = cells.length;
        if (N === 0) return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

        var CELL_W = 200;
        var CELL_H = 150;
        var ARROW_W = 40;
        var PAD = 16;
        var TITLE_H = title ? 36 : 0;
        var HEADER_H = 36;
        var BULLET_LINE_H = 20;
        var CORNER_R = 8;

        var totalW = N * CELL_W + (N - 1) * ARROW_W;
        var totalH = TITLE_H + CELL_H;
        var titleColor = isDark() ? '#e0e0e0' : '#333333';
        var arrowColor = isDark() ? '#888888' : '#666666';

        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" style="max-width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">';

        // Defs: clip paths + arrowhead marker
        svg += '<defs>';
        svg += '<marker id="sa-flow-arrow-' + uid + '" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="' + arrowColor + '"/></marker>';
        for (var i = 0; i < N; i++) {
            var cx = i * (CELL_W + ARROW_W);
            var cy = TITLE_H;
            svg += '<clipPath id="sa-flow-clip-' + uid + '-' + i + '"><rect x="' + cx + '" y="' + cy + '" width="' + CELL_W + '" height="' + HEADER_H + '" rx="' + CORNER_R + '" ry="' + CORNER_R + '"/></clipPath>';
        }
        svg += '</defs>';

        // Title
        if (title) {
            svg += '<text x="' + (totalW / 2) + '" y="' + (TITLE_H / 2 + 6) + '" text-anchor="middle" font-size="16" font-weight="bold" fill="' + titleColor + '">' + escapeXml(title) + '</text>';
        }

        for (var i = 0; i < N; i++) {
            var cell = cells[i];
            var x = i * (CELL_W + ARROW_W);
            var y = TITLE_H;
            var colors = getColors(cell.colorKey);

            svg += renderCellBox(uid, 'sa-flow-clip', i, x, y, CELL_W, CELL_H, colors, CORNER_R, HEADER_H);
            svg += renderHeaderText(x, y, CELL_W, HEADER_H, cell);
            svg += renderBullets(x, y, CELL_W, CELL_H, HEADER_H, PAD, BULLET_LINE_H, 18, cell, colors);

            // Arrow to next cell
            if (i < N - 1) {
                var ax1 = x + CELL_W + 6;
                var ax2 = x + CELL_W + ARROW_W - 6;
                var ay = TITLE_H + CELL_H / 2;
                svg += '<line x1="' + ax1 + '" y1="' + ay + '" x2="' + ax2 + '" y2="' + ay + '" stroke="' + arrowColor + '" stroke-width="2" marker-end="url(#sa-flow-arrow-' + uid + ')"/>';
            }
        }

        svg += '</svg>';
        return svg;
    }

    // ===== Cycle Renderer =====

    function renderCycle(parsed) {
        var uid = _instanceId++;
        var title = parsed.title;
        var cells = parsed.cells;
        var N = cells.length;
        if (N === 0) return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

        var CELL_W = 180;
        var CELL_H = 140;
        var HEADER_H = 36;
        var BULLET_LINE_H = 20;
        var CORNER_R = 8;
        var PAD = 16;
        var TITLE_H = title ? 36 : 0;

        // Calculate radius based on number of nodes and cell size
        var minDim = Math.max(CELL_W, CELL_H);
        var R = Math.max(minDim, N * 45);

        var cx = R + CELL_W / 2;
        var cy = TITLE_H + R + CELL_H / 2;
        var totalW = 2 * (R + CELL_W / 2);
        var totalH = TITLE_H + 2 * (R + CELL_H / 2);
        var titleColor = isDark() ? '#e0e0e0' : '#333333';
        var arrowColor = isDark() ? '#888888' : '#666666';

        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" style="max-width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">';

        // Defs: clip paths + arrowhead marker
        svg += '<defs>';
        svg += '<marker id="sa-cycle-arrow-' + uid + '" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="' + arrowColor + '"/></marker>';

        // Pre-calculate cell positions
        var positions = [];
        for (var i = 0; i < N; i++) {
            var angle = -Math.PI / 2 + i * (2 * Math.PI / N);
            positions.push({
                cx: cx + R * Math.cos(angle),
                cy: cy + R * Math.sin(angle),
                x: cx + R * Math.cos(angle) - CELL_W / 2,
                y: cy + R * Math.sin(angle) - CELL_H / 2,
                angle: angle
            });
        }

        for (var i = 0; i < N; i++) {
            var pos = positions[i];
            svg += '<clipPath id="sa-cycle-clip-' + uid + '-' + i + '"><rect x="' + pos.x + '" y="' + pos.y + '" width="' + CELL_W + '" height="' + HEADER_H + '" rx="' + CORNER_R + '" ry="' + CORNER_R + '"/></clipPath>';
        }
        svg += '</defs>';

        // Title
        if (title) {
            svg += '<text x="' + (totalW / 2) + '" y="' + (TITLE_H / 2 + 6) + '" text-anchor="middle" font-size="16" font-weight="bold" fill="' + titleColor + '">' + escapeXml(title) + '</text>';
        }

        // Draw arrows first (under cells)
        for (var i = 0; i < N; i++) {
            var next = (i + 1) % N;
            var from = positions[i];
            var to = positions[next];

            // Calculate edge points on cell boundaries
            var angleTo = Math.atan2(to.cy - from.cy, to.cx - from.cx);
            var angleFrom = Math.atan2(from.cy - to.cy, from.cx - to.cx);

            // Start point: edge of source cell
            var startX = from.cx + (CELL_W / 2 + 4) * Math.cos(angleTo);
            var startY = from.cy + (CELL_H / 2 + 4) * Math.sin(angleTo);

            // End point: edge of target cell
            var endX = to.cx + (CELL_W / 2 + 4) * Math.cos(angleFrom);
            var endY = to.cy + (CELL_H / 2 + 4) * Math.sin(angleFrom);

            // Curved arrow using quadratic bezier via center offset
            var midX = (startX + endX) / 2;
            var midY = (startY + endY) / 2;
            var perpX = endY - startY;
            var perpY = -(endX - startX);
            var perpLen = Math.sqrt(perpX * perpX + perpY * perpY);
            if (perpLen > 0) {
                perpX /= perpLen;
                perpY /= perpLen;
            }
            // Curve outward from center
            var curvature = 0.2;
            var ctrlX = midX + perpX * perpLen * curvature;
            var ctrlY = midY + perpY * perpLen * curvature;

            svg += '<path d="M' + startX.toFixed(1) + ' ' + startY.toFixed(1) + ' Q' + ctrlX.toFixed(1) + ' ' + ctrlY.toFixed(1) + ' ' + endX.toFixed(1) + ' ' + endY.toFixed(1) + '" fill="none" stroke="' + arrowColor + '" stroke-width="2" marker-end="url(#sa-cycle-arrow-' + uid + ')"/>';
        }

        // Draw cells (on top of arrows)
        for (var i = 0; i < N; i++) {
            var cell = cells[i];
            var pos = positions[i];
            var x = pos.x;
            var y = pos.y;
            var colors = getColors(cell.colorKey);

            svg += renderCellBox(uid, 'sa-cycle-clip', i, x, y, CELL_W, CELL_H, colors, CORNER_R, HEADER_H);
            svg += renderHeaderText(x, y, CELL_W, HEADER_H, cell);
            svg += renderBullets(x, y, CELL_W, CELL_H, HEADER_H, PAD, BULLET_LINE_H, 16, cell, colors);
        }

        svg += '</svg>';
        return svg;
    }
    // ===== Business Model Canvas Renderer =====

    function renderBmc(parsed) {
        var uid = _instanceId++;
        var title = parsed.title;
        var cells = parsed.cells;
        if (cells.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

        var COL_W = 200;
        var GAP = 6;
        var PAD = 16;
        var TITLE_H = title ? 36 : 0;
        var HEADER_H = 36;
        var BULLET_LINE_H = 20;
        var CORNER_R = 8;
        var TOP_H = 280;       // full height of top row
        var TOP_HALF = (TOP_H - GAP) / 2; // half height for stacked cells
        var BOT_H = 140;       // bottom row height

        var totalW = 5 * COL_W + 4 * GAP;
        var totalH = TITLE_H + TOP_H + GAP + BOT_H;
        var titleColor = isDark() ? '#e0e0e0' : '#333333';

        // Fixed layout: [x, y, w, h] for each of the 9 cells
        // Order: Key Partners, Key Activities, Key Resources, Value Propositions,
        //        Customer Relationships, Channels, Customer Segments, Cost Structure, Revenue Streams
        var col0 = 0;
        var col1 = COL_W + GAP;
        var col2 = 2 * (COL_W + GAP);
        var col3 = 3 * (COL_W + GAP);
        var col4 = 4 * (COL_W + GAP);
        var topY = TITLE_H;
        var botY = TITLE_H + TOP_H + GAP;
        var botHalfW = (totalW - GAP) / 2;

        var layout = [
            { x: col0, y: topY, w: COL_W, h: TOP_H },                     // 0: Key Partners
            { x: col1, y: topY, w: COL_W, h: TOP_HALF },                   // 1: Key Activities
            { x: col1, y: topY + TOP_HALF + GAP, w: COL_W, h: TOP_HALF },  // 2: Key Resources
            { x: col2, y: topY, w: COL_W, h: TOP_H },                     // 3: Value Propositions
            { x: col3, y: topY, w: COL_W, h: TOP_HALF },                   // 4: Customer Relationships
            { x: col3, y: topY + TOP_HALF + GAP, w: COL_W, h: TOP_HALF },  // 5: Channels
            { x: col4, y: topY, w: COL_W, h: TOP_H },                     // 6: Customer Segments
            { x: col0, y: botY, w: botHalfW, h: BOT_H },                  // 7: Cost Structure
            { x: col0 + botHalfW + GAP, y: botY, w: botHalfW, h: BOT_H }  // 8: Revenue Streams
        ];

        var maxCells = Math.min(cells.length, 9);

        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" style="max-width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">';

        // Defs for clip paths
        svg += '<defs>';
        for (var i = 0; i < maxCells; i++) {
            var L = layout[i];
            svg += '<clipPath id="sa-bmc-clip-' + uid + '-' + i + '"><rect x="' + L.x + '" y="' + L.y + '" width="' + L.w + '" height="' + HEADER_H + '" rx="' + CORNER_R + '" ry="' + CORNER_R + '"/></clipPath>';
        }
        svg += '</defs>';

        // Title
        if (title) {
            svg += '<text x="' + (totalW / 2) + '" y="' + (TITLE_H / 2 + 6) + '" text-anchor="middle" font-size="16" font-weight="bold" fill="' + titleColor + '">' + escapeXml(title) + '</text>';
        }

        // Render cells
        for (var i = 0; i < maxCells; i++) {
            var cell = cells[i];
            var L = layout[i];
            var x = L.x;
            var y = L.y;
            var w = L.w;
            var h = L.h;
            var colors = getColors(cell.colorKey);
            var maxCharWidth = Math.floor((w - PAD * 2 - 14) / 7.5);

            svg += renderCellBox(uid, 'sa-bmc-clip', i, x, y, w, h, colors, CORNER_R, HEADER_H);
            svg += renderHeaderText(x, y, w, HEADER_H, cell);
            svg += renderBullets(x, y, w, h, HEADER_H, PAD, BULLET_LINE_H, maxCharWidth, cell, colors);
        }

        svg += '</svg>';
        return svg;
    }


    // ===== Mandara Chart Renderer =====

    /**
     * Parse mandara-specific 3-level structure from raw source.
     *
     * Syntax:
     *   ```schemata
     *   mandara
     *   title: My Goal Chart
     *
     *   - Center goal
     *     - Sub-goal 1 (above-left in center block → center of above-left block)
     *       - Item 1-1 (above-left in that block)
     *       - Item 1-2 (above)
     *       - ... up to 8 items
     *     - Sub-goal 2 (above)
     *       - ...
     *     - ... up to 8 sub-goals
     *   ```
     *
     * The 8 positions around center follow reading order:
     *   [0] above-left  [1] above  [2] above-right
     *   [3] left                    [4] right
     *   [5] below-left  [6] below  [7] below-right
     */
    function parseMandara(source) {
        var lines = source.trim().split('\n');
        var lineIndex = 0;

        // Skip type line
        lineIndex++;

        // Skip blank lines
        while (lineIndex < lines.length && lines[lineIndex].trim() === '') lineIndex++;

        // Optional title
        var title = '';
        if (lineIndex < lines.length && lines[lineIndex].trim().indexOf('title:') === 0) {
            title = lines[lineIndex].trim().replace(/^title:\s*/, '');
            lineIndex++;
        }

        var center = '';
        var subGoals = [];
        var currentSubGoal = null;

        while (lineIndex < lines.length) {
            var raw = lines[lineIndex];
            var trimmed = raw.trim();

            if (trimmed === '' || !trimmed.match(/^-\s/)) { lineIndex++; continue; }

            // Count leading spaces
            var indent = raw.match(/^(\s*)/)[1].length;
            var text = trimmed.replace(/^-\s+/, '');

            if (indent === 0) {
                // Level 0: center
                center = text;
            } else if (indent >= 2 && indent < 4) {
                // Level 1: sub-goal
                if (currentSubGoal) subGoals.push(currentSubGoal);
                currentSubGoal = { text: text, items: [] };
            } else if (indent >= 4 && currentSubGoal) {
                // Level 2: item
                currentSubGoal.items.push(text);
            }

            lineIndex++;
        }
        if (currentSubGoal) subGoals.push(currentSubGoal);

        return { title: title, center: center, subGoals: subGoals };
    }

    function renderMandara(parsed) {
        var data = parseMandara(parsed.source);
        var title = data.title;

        var CELL_W = 100;
        var CELL_H = 75;
        var BLOCK_GAP = 4;
        var TITLE_H = title ? 36 : 0;
        var FONT_SIZE = 11;

        // Build 9x9 grid
        var grid = [];
        for (var r = 0; r < 9; r++) {
            grid[r] = [];
            for (var c = 0; c < 9; c++) {
                grid[r][c] = { text: '', type: 'normal' };
            }
        }

        // Place center
        grid[4][4] = { text: data.center, type: 'center' };

        // Direction offsets: above-left, above, above-right, left, right, below-left, below, below-right
        var DIRS = [
            [-1, -1], [-1, 0], [-1, 1],
            [ 0, -1],          [ 0, 1],
            [ 1, -1], [ 1, 0], [ 1, 1]
        ];

        for (var s = 0; s < Math.min(data.subGoals.length, 8); s++) {
            var d = DIRS[s];
            var sg = data.subGoals[s];

            // Place in center block
            grid[4 + d[0]][4 + d[1]] = { text: sg.text, type: 'subgoal' };

            // Place as center of outer block
            var ocr = (1 + d[0]) * 3 + 1;
            var occ = (1 + d[1]) * 3 + 1;
            grid[ocr][occ] = { text: sg.text, type: 'subgoal' };

            // Place items in outer block
            for (var i = 0; i < Math.min(sg.items.length, 8); i++) {
                grid[ocr + DIRS[i][0]][occ + DIRS[i][1]] = { text: sg.items[i], type: 'normal' };
            }
        }

        // Position helpers
        function cellX(col) {
            return col * CELL_W + Math.floor(col / 3) * BLOCK_GAP;
        }
        function cellY(row) {
            return TITLE_H + row * CELL_H + Math.floor(row / 3) * BLOCK_GAP;
        }

        var totalW = 9 * CELL_W + 2 * BLOCK_GAP;
        var totalH = TITLE_H + 9 * CELL_H + 2 * BLOCK_GAP;

        var dark = isDark();
        var theme = dark ? {
            cellBg: '#1e1e1e',
            subGoalBg: '#1a2744',
            centerBg: '#253a5e',
            cellBorder: '#444444',
            blockBorder: '#5588cc',
            text: '#d0d0d0',
            subGoalText: '#8ab4ff',
            centerText: '#ffffff'
        } : {
            cellBg: '#ffffff',
            subGoalBg: '#e8edf8',
            centerBg: '#c8d4f0',
            cellBorder: '#c0c0c0',
            blockBorder: '#4a7abf',
            text: '#333333',
            subGoalText: '#2255aa',
            centerText: '#1a3a7a'
        };

        var titleColor = dark ? '#e0e0e0' : '#333333';

        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" style="max-width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">';

        // Title
        if (title) {
            svg += '<text x="' + (totalW / 2) + '" y="' + (TITLE_H / 2 + 6) + '" text-anchor="middle" font-size="16" font-weight="bold" fill="' + titleColor + '">' + escapeXml(title) + '</text>';
        }

        // Render cells
        for (var r = 0; r < 9; r++) {
            for (var c = 0; c < 9; c++) {
                var cell = grid[r][c];
                var x = cellX(c);
                var y = cellY(r);
                var bg, textColor, fontWeight;

                if (cell.type === 'center') {
                    bg = theme.centerBg;
                    textColor = theme.centerText;
                    fontWeight = 'bold';
                } else if (cell.type === 'subgoal') {
                    bg = theme.subGoalBg;
                    textColor = theme.subGoalText;
                    fontWeight = 'bold';
                } else {
                    bg = theme.cellBg;
                    textColor = theme.text;
                    fontWeight = 'normal';
                }

                // Cell background
                svg += '<rect x="' + x + '" y="' + y + '" width="' + CELL_W + '" height="' + CELL_H + '" fill="' + bg + '" stroke="' + theme.cellBorder + '" stroke-width="0.5"/>';

                // Cell text (centered, wrapped)
                if (cell.text) {
                    var lines = wrapText(cell.text, 10);
                    var lineH = FONT_SIZE * 1.4;
                    var totalTextH = lines.length * lineH;
                    var startY = y + (CELL_H - totalTextH) / 2 + FONT_SIZE * 0.85;
                    var cx = x + CELL_W / 2;

                    for (var li = 0; li < lines.length; li++) {
                        svg += '<text x="' + cx + '" y="' + (startY + li * lineH).toFixed(1) + '" text-anchor="middle" font-size="' + FONT_SIZE + '" font-weight="' + fontWeight + '" fill="' + textColor + '">' + escapeXml(lines[li]) + '</text>';
                    }
                }
            }
        }

        // Draw 3x3 block borders on top
        for (var br = 0; br < 3; br++) {
            for (var bc = 0; bc < 3; bc++) {
                var bx = cellX(bc * 3);
                var by = cellY(br * 3);
                var bw = 3 * CELL_W;
                var bh = 3 * CELL_H;
                svg += '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh + '" fill="none" stroke="' + theme.blockBorder + '" stroke-width="2"/>';
            }
        }

        svg += '</svg>';
        return svg;
    }

    // ===== Fishbone (Ishikawa) Diagram Renderer =====

    /**
     * Parse fishbone-specific 3-level structure from raw source.
     *
     * Syntax:
     *   ```schemata
     *   fishbone
     *   title: Diagram Title
     *
     *   - Problem Statement (fish head / effect)
     *     - Category 1 (bone)
     *       - Sub-cause 1a
     *       - Sub-cause 1b
     *     - Category 2 (bone)
     *       - Sub-cause 2a
     *   ```
     */
    function parseFishbone(source) {
        var lines = source.trim().split('\n');
        var lineIndex = 0;

        // Skip type line
        var typeLine = (lines[lineIndex++] || '').trim();
        var options = typeLine.replace(/^\w+\s*/, '').trim();

        // Skip blank lines
        while (lineIndex < lines.length && lines[lineIndex].trim() === '') lineIndex++;

        // Optional title
        var title = '';
        if (lineIndex < lines.length && lines[lineIndex].trim().indexOf('title:') === 0) {
            title = lines[lineIndex].trim().replace(/^title:\s*/, '');
            lineIndex++;
        }

        var effect = '';
        var bones = [];
        var currentBone = null;
        var currentCause = null;

        while (lineIndex < lines.length) {
            var raw = lines[lineIndex];
            var trimmed = raw.trim();

            if (trimmed === '' || !trimmed.match(/^-\s/)) { lineIndex++; continue; }

            var indent = raw.match(/^(\s*)/)[1].length;
            var text = trimmed.replace(/^-\s+/, '');

            if (indent === 0) {
                // Level 0: effect (fish head)
                effect = text;
            } else if (indent >= 2 && indent < 4) {
                // Level 1: bone/category
                if (currentCause && currentBone) {
                    currentBone.causes.push(currentCause);
                }
                if (currentBone) bones.push(currentBone);
                currentBone = { text: text, causes: [] };
                currentCause = null;
            } else if (indent >= 4 && indent < 6 && currentBone) {
                // Level 2: sub-cause
                if (currentCause) {
                    currentBone.causes.push(currentCause);
                }
                currentCause = { text: text, children: [] };
            } else if (indent >= 6 && currentCause) {
                // Level 3: sub-sub-cause (branches from level 2)
                currentCause.children.push(text);
            }

            lineIndex++;
        }
        if (currentCause && currentBone) {
            currentBone.causes.push(currentCause);
        }
        if (currentBone) bones.push(currentBone);

        return { title: title, options: options, effect: effect, bones: bones };
    }

    function renderFishbone(parsed) {
        var uid = _instanceId++;
        var data = parseFishbone(parsed.source);
        var isVertical = (data.options || '').indexOf('vertical') >= 0;

        if (data.bones.length === 0) {
            return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
        }

        if (isVertical) {
            return renderFishboneVertical(uid, data);
        }
        return renderFishboneHorizontal(uid, data);
    }

    function renderFishboneHorizontal(uid, data) {
        var title = data.title;
        var effect = data.effect || 'Effect';
        var bones = data.bones;
        var N = bones.length;

        // Layout constants
        var TITLE_H = title ? 40 : 0;
        var RIB_SPACING = 200;
        var RIB_ANGLE = 80 / 180 * Math.PI;
        var SPINE_STROKE = 4;
        var TAIL_W = 50;
        var HEAD_W = 160;
        var HEAD_H = 70;
        var HEAD_GAP = 10;
        var CAT_BOX_W = 160;
        var CAT_BOX_H = 32;
        var CAT_FONT = 12;
        var SC_FONT = 11;
        var SC_DOT_R = 4;
        var SC_GAP = 22;
        var SC_LINE_LEN = 100;

        // Pre-compute per-bone rib length based on content height
        var L3_GAP_PRE = 16;
        var scLineH_PRE = SC_FONT + 2;
        var sinA = Math.sin(RIB_ANGLE);
        for (var i = 0; i < N; i++) {
            var bone = bones[i];
            var causeSlots = [];
            for (var c = 0; c < bone.causes.length; c++) {
                var cause = bone.causes[c];
                var textLines = wrapText(cause.text, 13);
                var textH = 4 + textLines.length * scLineH_PRE;
                var l3H = (cause.children && cause.children.length > 0) ? cause.children.length * L3_GAP_PRE + 4 : 0;
                causeSlots.push(Math.max(SC_GAP, textH + l3H));
            }
            var totalNeeded = SC_GAP; // padding
            for (var c = 0; c < causeSlots.length; c++) totalNeeded += causeSlots[c];
            bone._ribLength = Math.max(100, totalNeeded / sinA);
            bone._causeSlots = causeSlots;
            bone._totalNeeded = totalNeeded;
        }

        // Compute vertical extents from max rib length per side
        var maxTopRibVert = 0, maxBotRibVert = 0;
        for (var i = 0; i < N; i++) {
            var rv = bones[i]._ribLength * sinA;
            if (i % 2 === 0) { if (rv > maxTopRibVert) maxTopRibVert = rv; }
            else { if (rv > maxBotRibVert) maxBotRibVert = rv; }
        }
        var topExtent = maxTopRibVert + CAT_BOX_H / 2 + 20;
        var bottomExtent = maxBotRibVert + CAT_BOX_H / 2 + 20;

        var SPINE_Y = TITLE_H + topExtent;
        var spineStartX = TAIL_W;
        // Spine length: even → symmetric pairs, odd → alternating at half spacing
        var HEAD_MARGIN = RIB_SPACING * 0.1;
        var TAIL_MARGIN = RIB_SPACING * 0.9;
        var isSymmetric = (N % 2 === 0);
        var numSlots = isSymmetric ? N / 2 : N;
        var slotSpacing = isSymmetric ? RIB_SPACING : RIB_SPACING / 2;
        var spineLen = TAIL_MARGIN + Math.max(0, numSlots - 1) * slotSpacing + HEAD_MARGIN;
        var spineEndX = spineStartX + spineLen;
        var totalW = spineEndX + HEAD_GAP + HEAD_W + 10;
        var totalH = SPINE_Y + bottomExtent + 10;

        var dark = isDark();
        var titleColor = dark ? '#e0e0e0' : '#333333';
        var spineColor = dark ? '#888888' : '#555555';
        var tailColor = dark ? '#555555' : '#aaaaaa';
        var headFill = dark ? '#c0392b' : '#e74c6c';
        var headStroke = dark ? '#922b21' : '#c0392b';
        var headTextFill = '#ffffff';

        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" style="max-width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">';

        // Defs: arrowhead
        svg += '<defs>';
        svg += '<marker id="sa-fish-arrow-' + uid + '" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="' + spineColor + '"/></marker>';
        svg += '</defs>';

        // Title
        if (title) {
            svg += '<text x="' + (totalW / 2) + '" y="' + (TITLE_H / 2 + 6) + '" text-anchor="middle" font-size="16" font-weight="bold" fill="' + titleColor + '">' + escapeXml(title) + '</text>';
        }

        // Fish tail (V-shape on left)
        var tailTipX = 0;
        var tailBaseX = TAIL_W;
        var tailSpread = 40;
        svg += '<path d="M' + tailBaseX + ' ' + SPINE_Y + ' L' + tailTipX + ' ' + (SPINE_Y - tailSpread) + ' L' + (tailBaseX * 0.4) + ' ' + SPINE_Y + ' L' + tailTipX + ' ' + (SPINE_Y + tailSpread) + ' Z" fill="' + tailColor + '" opacity="0.6"/>';

        // Spine (thick horizontal line)
        svg += '<line x1="' + spineStartX + '" y1="' + SPINE_Y + '" x2="' + spineEndX + '" y2="' + SPINE_Y + '" stroke="' + spineColor + '" stroke-width="' + SPINE_STROKE + '"/>';

        // Fish head (pointed chevron shape on right)
        var hx = spineEndX + HEAD_GAP;
        var hy = SPINE_Y;
        // Fish head: body ellipse + pointed nose
        var bodyW = HEAD_W * 0.65;
        var noseW = HEAD_W * 0.35;
        svg += '<path d="M' + hx + ' ' + (hy - HEAD_H / 2) +
            ' L' + (hx + bodyW) + ' ' + (hy - HEAD_H / 2) +
            ' L' + (hx + bodyW + noseW) + ' ' + hy +
            ' L' + (hx + bodyW) + ' ' + (hy + HEAD_H / 2) +
            ' L' + hx + ' ' + (hy + HEAD_H / 2) +
            ' Z" fill="' + headFill + '" stroke="' + headStroke + '" stroke-width="2"/>';
        // Eye
        var eyeX = hx + bodyW + noseW * 0.45;
        var eyeY = hy - HEAD_H * 0.18;
        svg += '<circle cx="' + eyeX + '" cy="' + eyeY + '" r="5" fill="#ffffff"/>';
        svg += '<circle cx="' + eyeX + '" cy="' + eyeY + '" r="2.5" fill="' + headFill + '"/>';
        // Effect text inside head
        var effectLines = wrapText(effect, 14);
        var effectLineH = 15;
        var effectStartY = hy - (effectLines.length * effectLineH) / 2 + 11;
        for (var el = 0; el < effectLines.length; el++) {
            svg += '<text x="' + (hx + bodyW * 0.5) + '" y="' + (effectStartY + el * effectLineH) + '" text-anchor="middle" font-size="13" font-weight="bold" fill="' + headTextFill + '">' + escapeXml(effectLines[el]) + '</text>';
        }

        // Bones (ribs) — placed alternately top/bottom, first bone near head
        function renderBones() {
            var cosA = Math.cos(RIB_ANGLE);
            var sinALocal = Math.sin(RIB_ANGLE);

            for (var i = 0; i < N; i++) {
                var bone = bones[i];
                var colorKey = COLOR_KEYS[i % COLOR_KEYS.length];
                var colors = getColors(colorKey);
                var dir = (i % 2 === 0) ? -1 : 1; // alternate: top, bottom

                // Per-bone rib length
                var boneRibLength = bone._ribLength;

                // Attachment point on spine — bone[0] near head, bone[N-1] near tail
                // Even: pairs share X (floor(i/2)), Odd: each bone own X at half spacing
                var slotIdx = isSymmetric ? Math.floor(i / 2) : i;
                var attachX = spineEndX - HEAD_MARGIN - slotIdx * slotSpacing;
                var attachY = SPINE_Y;

                // Rib endpoint (toward tail = negative X direction)
                var ribEndX = attachX - boneRibLength * cosA;
                var ribEndY = attachY + dir * boneRibLength * sinALocal;

                // Bone line
                svg += '<line x1="' + attachX + '" y1="' + attachY + '" x2="' + ribEndX + '" y2="' + ribEndY + '" stroke="' + colors.stroke + '" stroke-width="2.5"/>';

                // Category label box at rib tip — left edge aligned with rib endpoint
                var boxX = ribEndX - CAT_BOX_W;
                var boxY;
                if (dir < 0) {
                    boxY = ribEndY - CAT_BOX_H - 4;
                } else {
                    boxY = ribEndY + 4;
                }
                svg += '<rect x="' + boxX + '" y="' + boxY + '" width="' + CAT_BOX_W + '" height="' + CAT_BOX_H + '" rx="6" ry="6" fill="' + colors.stroke + '"/>';
                var catLines = wrapText(bone.text, 16);
                var catLineH = 14;
                var catTextY = boxY + (CAT_BOX_H - catLines.length * catLineH) / 2 + 11;
                for (var cl = 0; cl < catLines.length; cl++) {
                    svg += '<text x="' + (boxX + CAT_BOX_W / 2) + '" y="' + (catTextY + cl * catLineH) + '" text-anchor="middle" font-size="' + CAT_FONT + '" font-weight="bold" fill="#ffffff">' + escapeXml(catLines[cl]) + '</text>';
                }

                // Sub-causes along the bone — cumulative positioning based on content height
                var nCauses = bone.causes.length;
                var causeSlots = bone._causeSlots;
                var totalNeeded = bone._totalNeeded;
                var cumH = SC_GAP / 2; // initial padding
                for (var c = 0; c < nCauses; c++) {
                    // Position at midpoint of this cause's slot
                    var t = (cumH + causeSlots[c] / 2) / totalNeeded;
                    cumH += causeSlots[c];
                    var scX = ribEndX + t * (attachX - ribEndX);
                    var scY = ribEndY + t * (attachY - ribEndY);

                    // Horizontal sub-cause line (toward left, parallel to spine)
                    var scEndX = scX - SC_LINE_LEN;
                    var scEndY = scY;

                    svg += '<line x1="' + scX + '" y1="' + scY + '" x2="' + scEndX + '" y2="' + scEndY + '" stroke="' + colors.stroke + '" stroke-width="1.5" opacity="0.7"/>';

                    // Colored dot at junction
                    svg += '<circle cx="' + scX + '" cy="' + scY + '" r="' + SC_DOT_R + '" fill="' + colors.stroke + '"/>';

                    // Sub-cause text (render all wrapped lines)
                    var cause = bone.causes[c];
                    var scTextLines = wrapText(cause.text, 13);
                    var scLineH = SC_FONT + 2;
                    for (var sl = 0; sl < scTextLines.length; sl++) {
                        svg += '<text x="' + (scEndX - 4) + '" y="' + (scEndY + 4 + sl * scLineH) + '" text-anchor="end" font-size="' + SC_FONT + '" fill="' + (dark ? '#cccccc' : '#444444') + '">' + escapeXml(scTextLines[sl]) + '</text>';
                    }

                    // Level 3: sub-sub-causes branching from the sub-cause line
                    if (cause.children && cause.children.length > 0) {
                        var L3_GAP = 16;
                        var L3_LINE_LEN = 30;
                        var L3_FONT = 9;
                        // For top bones (dir<0), L3 branches go downward — offset past text
                        var l3BaseY = scEndY;
                        if (dir < 0) {
                            l3BaseY = scEndY + 4 + scTextLines.length * scLineH;
                        }
                        for (var d = 0; d < cause.children.length; d++) {
                            // Branch vertically from midpoint of sub-cause line, away from spine
                            var l3AttachX = scEndX + (scX - scEndX) * 0.35;
                            var l3Y = l3BaseY - dir * (d + 1) * L3_GAP;

                            // Vertical line from sub-cause line to level 3
                            svg += '<line x1="' + l3AttachX + '" y1="' + l3BaseY + '" x2="' + l3AttachX + '" y2="' + l3Y + '" stroke="' + colors.stroke + '" stroke-width="1" opacity="0.5"/>';
                            // Horizontal branch
                            var l3EndX = l3AttachX - L3_LINE_LEN;
                            svg += '<line x1="' + l3AttachX + '" y1="' + l3Y + '" x2="' + l3EndX + '" y2="' + l3Y + '" stroke="' + colors.stroke + '" stroke-width="1" opacity="0.5"/>';
                            // Small dot
                            svg += '<circle cx="' + l3AttachX + '" cy="' + l3Y + '" r="2.5" fill="' + colors.stroke + '" opacity="0.6"/>';
                            // Text
                            svg += '<text x="' + (l3EndX - 3) + '" y="' + (l3Y + 3) + '" text-anchor="end" font-size="' + L3_FONT + '" fill="' + (dark ? '#aaaaaa' : '#666666') + '">' + escapeXml(cause.children[d]) + '</text>';
                        }
                    }
                }
            }
        }

        renderBones();

        svg += '</svg>';
        return svg;
    }

    function renderFishboneVertical(_uid, data) {
        var title = data.title;
        var effect = data.effect || 'Effect';
        var bones = data.bones;
        var N = bones.length;

        // Layout constants
        var TITLE_H = title ? 40 : 0;
        var EFFECT_W = 220;
        var EFFECT_H = 50;
        var EFFECT_R = 8;
        var CAT_W = 160;
        var CAT_H = 32;
        var CAT_GAP = 30;
        var CAUSE_H = 24;
        var CAUSE_GAP = 6;
        var LEVEL_GAP_1 = 50;
        var LEVEL_GAP_2 = 36;
        var BRANCH_TO_CAT_GAP = 10;
        var PAD = 20;

        var dark = isDark();
        var titleColor = dark ? '#e0e0e0' : '#333333';
        var lineColor = dark ? '#666666' : '#999999';
        var effectFill = dark ? '#c0392b' : '#e74c6c';
        var effectStroke = dark ? '#922b21' : '#c0392b';

        // Calculate max cause area height (accounting for level 3 children)
        var L3_H = 20;
        var L3_GAP_V = 4;
        var maxCauseAreaH = 0;
        for (var i = 0; i < N; i++) {
            var boneH = 0;
            for (var j = 0; j < bones[i].causes.length; j++) {
                boneH += CAUSE_H + CAUSE_GAP;
                var nChildren = (bones[i].causes[j].children || []).length;
                if (nChildren > 0) {
                    boneH += nChildren * (L3_H + L3_GAP_V);
                }
            }
            if (boneH > maxCauseAreaH) maxCauseAreaH = boneH;
        }

        var catRowW = N * CAT_W + (N - 1) * CAT_GAP;
        var totalW = Math.max(EFFECT_W + 40, catRowW + PAD * 2);
        var effectX = (totalW - EFFECT_W) / 2;
        var effectY = TITLE_H + 10;
        var catRowY = effectY + EFFECT_H + LEVEL_GAP_1;
        var catStartX = (totalW - catRowW) / 2;
        var causeStartY = catRowY + BRANCH_TO_CAT_GAP + CAT_H + LEVEL_GAP_2;
        var totalH = causeStartY + maxCauseAreaH + PAD;

        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalW + ' ' + totalH + '" width="' + totalW + '" height="' + totalH + '" style="max-width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">';

        // Title
        if (title) {
            svg += '<text x="' + (totalW / 2) + '" y="' + (TITLE_H / 2 + 6) + '" text-anchor="middle" font-size="16" font-weight="bold" fill="' + titleColor + '">' + escapeXml(title) + '</text>';
        }

        // Effect box at top
        svg += '<rect x="' + effectX + '" y="' + effectY + '" width="' + EFFECT_W + '" height="' + EFFECT_H + '" rx="' + EFFECT_R + '" fill="' + effectFill + '" stroke="' + effectStroke + '" stroke-width="2"/>';
        var effectLines = wrapText(effect, 22);
        var effectLineH = 16;
        var effectTextY = effectY + (EFFECT_H - effectLines.length * effectLineH) / 2 + 12;
        for (var el = 0; el < effectLines.length; el++) {
            svg += '<text x="' + (effectX + EFFECT_W / 2) + '" y="' + (effectTextY + el * effectLineH) + '" text-anchor="middle" font-size="14" font-weight="bold" fill="#ffffff">' + escapeXml(effectLines[el]) + '</text>';
        }

        // Trunk line from effect to category row
        var trunkX = totalW / 2;
        svg += '<line x1="' + trunkX + '" y1="' + (effectY + EFFECT_H) + '" x2="' + trunkX + '" y2="' + catRowY + '" stroke="' + lineColor + '" stroke-width="2"/>';

        // Horizontal branch line connecting categories
        if (N > 1) {
            var branchX1 = catStartX + CAT_W / 2;
            var branchX2 = catStartX + (N - 1) * (CAT_W + CAT_GAP) + CAT_W / 2;
            svg += '<line x1="' + branchX1 + '" y1="' + catRowY + '" x2="' + branchX2 + '" y2="' + catRowY + '" stroke="' + lineColor + '" stroke-width="2"/>';
        }

        // Category boxes and sub-causes
        for (var i = 0; i < N; i++) {
            var bone = bones[i];
            var colorKey = COLOR_KEYS[i % COLOR_KEYS.length];
            var colors = getColors(colorKey);
            var catX = catStartX + i * (CAT_W + CAT_GAP);
            var catCenterX = catX + CAT_W / 2;

            // Vertical connector from branch line to category box
            var catBoxY = catRowY + BRANCH_TO_CAT_GAP;
            svg += '<line x1="' + catCenterX + '" y1="' + catRowY + '" x2="' + catCenterX + '" y2="' + (catBoxY + CAT_H) + '" stroke="' + lineColor + '" stroke-width="1.5"/>';

            // Category box
            svg += '<rect x="' + catX + '" y="' + catBoxY + '" width="' + CAT_W + '" height="' + CAT_H + '" rx="6" fill="' + colors.stroke + '"/>';
            var catLines = wrapText(bone.text, 16);
            var catLineH = 14;
            var catTextY = catBoxY + (CAT_H - catLines.length * catLineH) / 2 + 11;
            for (var cl = 0; cl < catLines.length; cl++) {
                svg += '<text x="' + catCenterX + '" y="' + (catTextY + cl * catLineH) + '" text-anchor="middle" font-size="12" font-weight="bold" fill="#ffffff">' + escapeXml(catLines[cl]) + '</text>';
            }

            // Sub-causes below (cumulative Y to account for level 3 children)
            var cumY = causeStartY;
            if (bone.causes.length > 0) {
                // Calculate total height for vertical connector line
                var tempY = causeStartY;
                for (var tc = 0; tc < bone.causes.length; tc++) {
                    if (tc > 0) tempY += CAUSE_H + CAUSE_GAP;
                    var tcChildren = (bone.causes[tc].children || []).length;
                    if (tcChildren > 0) tempY += tcChildren * (L3_H + L3_GAP_V);
                }
                var causeBottomY = tempY + CAUSE_H / 2;
                svg += '<line x1="' + catCenterX + '" y1="' + (catBoxY + CAT_H) + '" x2="' + catCenterX + '" y2="' + causeBottomY + '" stroke="' + colors.stroke + '" stroke-width="1.5" opacity="0.4"/>';
            }

            for (var c = 0; c < bone.causes.length; c++) {
                var causeY = cumY;
                var causeX = catCenterX - CAT_W * 0.45;
                var causeW = CAT_W * 0.9;

                // Cause box
                svg += '<rect x="' + causeX + '" y="' + causeY + '" width="' + causeW + '" height="' + CAUSE_H + '" rx="4" fill="' + colors.fill + '" stroke="' + colors.stroke + '" stroke-width="1" opacity="0.8"/>';

                // Dot
                svg += '<circle cx="' + (causeX + 12) + '" cy="' + (causeY + CAUSE_H / 2) + '" r="3" fill="' + colors.stroke + '"/>';

                // Cause text
                svg += '<text x="' + (causeX + 22) + '" y="' + (causeY + CAUSE_H / 2 + 4) + '" font-size="11" fill="' + colors.title + '">' + escapeXml(bone.causes[c].text) + '</text>';

                cumY += CAUSE_H + CAUSE_GAP;

                // Level 3 children
                var children = bone.causes[c].children || [];
                if (children.length > 0) {
                    for (var d = 0; d < children.length; d++) {
                        var l3Y = cumY;
                        var l3X = causeX + 16;
                        var l3W = causeW - 16;
                        svg += '<rect x="' + l3X + '" y="' + l3Y + '" width="' + l3W + '" height="' + L3_H + '" rx="3" fill="' + colors.fill + '" stroke="' + colors.stroke + '" stroke-width="0.5" opacity="0.6"/>';
                        svg += '<text x="' + (l3X + 10) + '" y="' + (l3Y + L3_H / 2 + 3) + '" font-size="9" fill="' + colors.title + '">' + escapeXml(children[d]) + '</text>';
                        cumY += L3_H + L3_GAP_V;
                    }
                }
            }
        }

        svg += '</svg>';
        return svg;
    }

    // ===== Public API =====

    /**
     * Render a schemata source string into an SVG string.
     *
     * @param {string} source - Raw code block content
     * @returns {string} SVG markup
     * @throws {Error} If the diagram type is not supported
     */
    function render(source) {
        var parsed = parse(source);
        parsed.source = source;
        var renderer = RENDERERS[parsed.type];
        if (!renderer) {
            throw new Error('Unsupported Schemata type: ' + parsed.type);
        }
        return applyScale(renderer(parsed), parsed.scale);
    }

    /**
     * Find all elements with [data-schemata] attribute inside a container
     * and replace their content with rendered SVG.
     *
     * @param {Element} [container=document] - DOM element to search within
     */
    function renderAll(container) {
        container = container || document;
        var elements = container.querySelectorAll('[data-schemata]');
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            try {
                var source = el.getAttribute('data-schemata-source');
                if (!source) continue;
                el.innerHTML = render(decodeURIComponent(source));
            } catch (error) {
                el.innerHTML = '<pre style="color:red;">Schemata Error: ' + escapeXml(error.message) + '</pre>';
            }
        }
    }

    // Export
    global.Schemata = {
        parse: parse,
        render: render,
        renderAll: renderAll,
        PALETTE: PALETTE,
        RENDERERS: RENDERERS,
        utils: {
            escapeXml: escapeXml,
            getColors: getColors,
            isDark: isDark,
            measureTextWidth: measureTextWidth,
            wrapText: wrapText
        }
    };

})(typeof window !== 'undefined' ? window : this);
