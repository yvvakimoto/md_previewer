/**
 * Kataskeve (κατασκευή, "construction") - Elementary Euclidean geometry
 * diagram renderer for md-previewer. (Earlier working titles, both withdrawn
 * to avoid name collisions: "euclid" — collided with npm "euclid.js";
 * "sakuzu" — collided with the Microsoft Store UWP app "Sakuzu", also a
 * Windows diagram tool. "Kataskeve" is the term Euclid used in the Elements
 * for the *construction step* of a proposition.)
 *
 * Original implementation. No code, algorithms in copyrightable form, or test
 * fixtures have been derived from the GPL-licensed Eukleides tool or from any
 * other JavaScript geometry library (e.g. the unrelated npm package "euclid.js").
 * The mathematical constructions used internally (midpoint, foot of perpendicular,
 * circle through three points, orthocenter, line/circle intersection, etc.)
 * are textbook Euclidean geometry and are not subject to copyright. The
 * source language, parser, evaluator, and SVG renderer were designed
 * independently for this project. Distributed under the same license as
 * md-previewer.
 *
 * Usage:
 *   Kataskeve.renderAll(containerElement);
 *   var svg = Kataskeve.render(sourceText);  // -> SVG string (or .kataskeve-error div)
 *
 * Source language (line-oriented; `#` starts a comment unless followed by a hex digit):
 *
 *   # settings (top-level "key: value" lines)
 *   viewport: -1 -1 7 6        # xmin ymin xmax ymax (auto if omitted)
 *   unit: 60                   # pixels per world unit (default 40)
 *   grid: on                   # off by default
 *   axes: on                   # off by default
 *
 *   # assignments (bind a value to a name; do NOT draw)
 *   A = point(0, 0)
 *   T = triangle(5, 4, 6)      # SSS; or triangle(A, B, C); or triangle() default
 *
 *   # draw commands (bare expression, optional trailing style tokens)
 *   triangle(A, B, C)
 *   nine = circle3(Ma, Mb, Mc)
 *   nine color=#c0392b thick
 *
 *   # label / mark commands
 *   label A "A" pos=SW
 *   mark right_angle(P, Q, R)
 *
 * Multiple statements on a line via `;`. See samples/kataskeve.md.
 */
(function (global) {
    'use strict';

    // ============ Utilities ============

    function escapeXml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isDark() {
        return !!(global.document && global.document.body &&
                  global.document.body.classList.contains('dark-mode'));
    }

    // Approximate text width in pixels for SVG label box sizing.
    // CJK ~ 1 em, ASCII ~ 0.55 em.
    function measureLabelWidth(text, fontSizePx) {
        var w = 0;
        for (var i = 0; i < text.length; i++) {
            var code = text.charCodeAt(i);
            var em = ((code >= 0x3000 && code <= 0x9FFF) ||
                      (code >= 0xF900 && code <= 0xFAFF) ||
                      (code >= 0xFF00 && code <= 0xFFEF)) ? 1.0 : 0.55;
            w += em;
        }
        return w * fontSizePx;
    }

    // ============ Tokenizer ============

    var TOK = {
        NUM: 'NUM', STR: 'STR', HEX: 'HEX', IDENT: 'IDENT',
        LPAREN: '(', RPAREN: ')', COMMA: ',', SEMI: ';', COLON: ':',
        EQ: '=', PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/', DOT: '.',
        NL: 'NL', EOF: 'EOF'
    };

    function tokenize(src) {
        var tokens = [];
        var i = 0, line = 1, col = 1;
        var n = src.length;

        function push(type, value, lineNum) {
            tokens.push({ type: type, value: value, line: lineNum != null ? lineNum : line });
        }

        while (i < n) {
            var ch = src[i];

            // Skip horizontal whitespace
            if (ch === ' ' || ch === '\t' || ch === '\r') {
                i++; col++; continue;
            }
            // Newline -> NL token (statement terminator)
            if (ch === '\n') {
                push(TOK.NL, '\n');
                i++; line++; col = 1;
                continue;
            }
            // Comment: `#` only when NOT followed by hex digit (then it's a color literal)
            if (ch === '#') {
                var next = src[i + 1];
                if (next && /[0-9a-fA-F]/.test(next)) {
                    // Hex color literal: #rgb #rgba #rrggbb #rrggbbaa
                    var j = i + 1;
                    while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
                    push(TOK.HEX, src.substring(i, j));
                    col += (j - i);
                    i = j;
                    continue;
                }
                // Comment to end of line
                while (i < n && src[i] !== '\n') i++;
                continue;
            }
            // String literal
            if (ch === '"' || ch === "'") {
                var quote = ch;
                var j2 = i + 1;
                var s = '';
                while (j2 < n && src[j2] !== quote) {
                    if (src[j2] === '\\' && j2 + 1 < n) {
                        s += src[j2 + 1];
                        j2 += 2;
                    } else {
                        s += src[j2];
                        j2++;
                    }
                }
                if (j2 >= n) throw new Error('Line ' + line + ': unterminated string');
                push(TOK.STR, s);
                col += (j2 + 1 - i);
                i = j2 + 1;
                continue;
            }
            // Number (integer or decimal); leading '-' handled by parser as unary
            if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1]))) {
                var k = i;
                while (k < n && /[0-9]/.test(src[k])) k++;
                if (src[k] === '.') {
                    k++;
                    while (k < n && /[0-9]/.test(src[k])) k++;
                }
                push(TOK.NUM, parseFloat(src.substring(i, k)));
                col += (k - i);
                i = k;
                continue;
            }
            // Identifier
            if (/[A-Za-z_]/.test(ch)) {
                var k2 = i;
                while (k2 < n && /[A-Za-z0-9_]/.test(src[k2])) k2++;
                push(TOK.IDENT, src.substring(i, k2));
                col += (k2 - i);
                i = k2;
                continue;
            }
            // Single-char operators
            switch (ch) {
                case '(': push(TOK.LPAREN, ch); i++; col++; continue;
                case ')': push(TOK.RPAREN, ch); i++; col++; continue;
                case ',': push(TOK.COMMA, ch); i++; col++; continue;
                case ';': push(TOK.SEMI, ch); i++; col++; continue;
                case ':': push(TOK.COLON, ch); i++; col++; continue;
                case '=': push(TOK.EQ, ch); i++; col++; continue;
                case '+': push(TOK.PLUS, ch); i++; col++; continue;
                case '-': push(TOK.MINUS, ch); i++; col++; continue;
                case '*': push(TOK.STAR, ch); i++; col++; continue;
                case '/': push(TOK.SLASH, ch); i++; col++; continue;
                case '.': push(TOK.DOT, ch); i++; col++; continue;
            }
            throw new Error('Line ' + line + ': unexpected character `' + ch + '`');
        }
        push(TOK.EOF, '');
        return tokens;
    }

    // ============ Parser ============
    //
    // Splits tokens into statements (separated by NL or `;`). For each
    // statement, classifies as: setting (IDENT ':' ...), assignment
    // (IDENT '=' expr style*), label, mark, or draw (expr style*).
    //
    // Style tokens (after a draw expression) are parsed greedily as:
    //   bare IDENT  -> { key: ident, value: true }
    //   IDENT = val -> { key: ident, value: val } where val is NUM/STR/HEX/IDENT/-NUM
    //
    // Expression grammar (precedence climbing, all numeric):
    //   expr   = term (('+' | '-') term)*
    //   term   = unary (('*' | '/') unary)*
    //   unary  = '-' unary | postfix
    //   postfix= primary ( '.' IDENT )*
    //   primary= NUM | STR | HEX | IDENT [ '(' args ')' ] | '(' expr ')'
    //   args   = arg (',' arg)*
    //   arg    = IDENT '=' expr | expr   (keyword arg or positional)

    function parse(src) {
        var tokens = tokenize(src);
        var pos = 0;

        function peek(off) { return tokens[pos + (off || 0)]; }
        function curLine() { return peek().line; }
        function eat(type) {
            var t = tokens[pos];
            if (t.type !== type) {
                throw new Error('Line ' + t.line + ': expected ' + type + ' but got ' + t.type +
                                ' (' + JSON.stringify(t.value) + ')');
            }
            pos++; return t;
        }
        function skipNL() {
            while (peek().type === TOK.NL || peek().type === TOK.SEMI) pos++;
        }

        // ---- expressions ----
        function parseExpr() { return parseAddSub(); }
        function parseAddSub() {
            var left = parseMulDiv();
            while (peek().type === TOK.PLUS || peek().type === TOK.MINUS) {
                var op = peek().type; pos++;
                var right = parseMulDiv();
                left = { kind: 'binop', op: op, left: left, right: right, line: curLine() };
            }
            return left;
        }
        function parseMulDiv() {
            var left = parseUnary();
            while (peek().type === TOK.STAR || peek().type === TOK.SLASH) {
                var op = peek().type; pos++;
                var right = parseUnary();
                left = { kind: 'binop', op: op, left: left, right: right, line: curLine() };
            }
            return left;
        }
        function parseUnary() {
            if (peek().type === TOK.MINUS) {
                pos++;
                var u = parseUnary();
                return { kind: 'neg', value: u, line: curLine() };
            }
            return parsePostfix();
        }
        function parsePostfix() {
            var node = parsePrimary();
            while (peek().type === TOK.DOT) {
                pos++;
                var name = eat(TOK.IDENT).value;
                node = { kind: 'member', object: node, name: name, line: curLine() };
            }
            return node;
        }
        function parsePrimary() {
            var t = peek();
            if (t.type === TOK.NUM) { pos++; return { kind: 'num', value: t.value, line: t.line }; }
            if (t.type === TOK.STR) { pos++; return { kind: 'str', value: t.value, line: t.line }; }
            if (t.type === TOK.HEX) { pos++; return { kind: 'hex', value: t.value, line: t.line }; }
            if (t.type === TOK.LPAREN) {
                pos++;
                var e = parseExpr();
                eat(TOK.RPAREN);
                return e;
            }
            if (t.type === TOK.IDENT) {
                var name = t.value; var lineN = t.line; pos++;
                if (peek().type === TOK.LPAREN) {
                    pos++;
                    var args = [];
                    if (peek().type !== TOK.RPAREN) {
                        for (;;) {
                            // Look ahead: IDENT '=' (and not '==' since we don't have it)
                            if (peek().type === TOK.IDENT && peek(1).type === TOK.EQ) {
                                var kname = eat(TOK.IDENT).value;
                                eat(TOK.EQ);
                                var kval = parseExpr();
                                args.push({ kw: kname, value: kval });
                            } else {
                                args.push({ kw: null, value: parseExpr() });
                            }
                            if (peek().type === TOK.COMMA) { pos++; continue; }
                            break;
                        }
                    }
                    eat(TOK.RPAREN);
                    return { kind: 'call', name: name, args: args, line: lineN };
                }
                return { kind: 'var', name: name, line: lineN };
            }
            throw new Error('Line ' + t.line + ': unexpected token `' + t.type + '`');
        }

        // ---- styles ----
        // Style tokens form a flat trailing list; each entry is either:
        //   bare:  IDENT      -> { key, value: true }
        //   kv:    IDENT '=' literal   where literal is NUM | NEG-NUM | HEX | STR | IDENT
        function parseStyles() {
            var styles = {};
            while (peek().type === TOK.IDENT) {
                var key = peek().value;
                // Treat well-formed kv pairs and bare keywords; stop on anything else
                if (peek(1).type === TOK.EQ) {
                    pos += 2;
                    var v = peek();
                    var val;
                    if (v.type === TOK.NUM) { val = v.value; pos++; }
                    else if (v.type === TOK.MINUS && peek(1).type === TOK.NUM) {
                        val = -peek(1).value; pos += 2;
                    }
                    else if (v.type === TOK.HEX) { val = v.value; pos++; }
                    else if (v.type === TOK.STR) { val = v.value; pos++; }
                    else if (v.type === TOK.IDENT) { val = v.value; pos++; }
                    else {
                        throw new Error('Line ' + v.line + ': bad style value after `' + key + '=`');
                    }
                    styles[key] = val;
                } else {
                    pos++;
                    styles[key] = true;
                }
            }
            return styles;
        }

        // ---- statement-level ----
        function parseStatement() {
            var startLine = curLine();
            var t0 = peek();

            // setting:  IDENT ':' <rest_of_line>
            if (t0.type === TOK.IDENT && peek(1).type === TOK.COLON) {
                var key = eat(TOK.IDENT).value;
                eat(TOK.COLON);
                // Collect raw tokens until NL/SEMI/EOF
                var raw = [];
                while (peek().type !== TOK.NL && peek().type !== TOK.SEMI && peek().type !== TOK.EOF) {
                    var tk = peek();
                    raw.push(tk);
                    pos++;
                }
                return { kind: 'setting', key: key, raw: raw, line: startLine };
            }

            // label "..." [pos=...]
            if (t0.type === TOK.IDENT && t0.value === 'label') {
                pos++;
                var target = parseExpr();
                if (peek().type !== TOK.STR) {
                    throw new Error('Line ' + startLine + ': label requires a string after the target');
                }
                var text = peek().value; pos++;
                var styles = parseStyles();
                return { kind: 'label', target: target, text: text, styles: styles, line: startLine };
            }

            // mark right_angle(...) / mark angle(...) / mark tick(...)
            if (t0.type === TOK.IDENT && t0.value === 'mark') {
                pos++;
                var which = peek();
                if (which.type !== TOK.IDENT) {
                    throw new Error('Line ' + startLine + ': mark requires a name (right_angle | angle | tick)');
                }
                var expr = parseExpr();   // expects a `call` node
                var styles2 = parseStyles();
                return { kind: 'mark', expr: expr, styles: styles2, line: startLine };
            }

            // assignment: IDENT '=' expr [styles]
            if (t0.type === TOK.IDENT && peek(1).type === TOK.EQ) {
                var name = eat(TOK.IDENT).value;
                eat(TOK.EQ);
                var rhs = parseExpr();
                // Assignment does NOT support trailing styles by spec (assign just binds).
                return { kind: 'assign', name: name, value: rhs, line: startLine };
            }

            // draw command: <expr> [styles]
            var dexpr = parseExpr();
            var dstyles = parseStyles();
            return { kind: 'draw', expr: dexpr, styles: dstyles, line: startLine };
        }

        // ---- program ----
        var stmts = [];
        skipNL();
        while (peek().type !== TOK.EOF) {
            stmts.push(parseStatement());
            // Statement terminator: NL or SEMI; consume all consecutive ones
            if (peek().type === TOK.NL || peek().type === TOK.SEMI) {
                skipNL();
            } else if (peek().type !== TOK.EOF) {
                throw new Error('Line ' + curLine() + ': expected end-of-line or `;` but got `' +
                                peek().type + '`');
            }
        }
        return stmts;
    }

    // ============ Geometric primitives ============

    var EPS = 1e-9;

    function P(x, y) { return { kind: 'point', x: x, y: y }; }
    function V(x, y) { return { kind: 'vector', x: x, y: y }; }
    function Seg(p, q) { return { kind: 'segment', p: p, q: q }; }
    function Lin(p, q) { return { kind: 'line', p: p, q: q }; }
    function Ray_(p, q) { return { kind: 'ray', p: p, q: q }; }
    function Cir(c, r) { return { kind: 'circle', center: c, radius: r }; }
    function Arc_(c, r, s, e) { return { kind: 'arc', center: c, radius: r, start: s, end: e }; }
    function Poly(pts) { return { kind: 'polygon', points: pts }; }

    function isPoint(o)   { return o && o.kind === 'point'; }
    function isLinear(o)  { return o && (o.kind === 'line' || o.kind === 'segment' || o.kind === 'ray'); }
    function isCircle(o)  { return o && o.kind === 'circle'; }
    function isPolygon(o) { return o && o.kind === 'polygon'; }
    function isVector(o)  { return o && o.kind === 'vector'; }
    function isNum(o)     { return typeof o === 'number'; }

    function dist(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }

    function midpoint(p, q) { return P((p.x + q.x) / 2, (p.y + q.y) / 2); }

    function footOnLine(p, a, b) {
        var dx = b.x - a.x, dy = b.y - a.y;
        var L2 = dx * dx + dy * dy;
        if (L2 < EPS) throw new Error('foot: a and b coincide');
        var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
        return P(a.x + t * dx, a.y + t * dy);
    }

    function circleThrough(p, q, r) {
        var ax = p.x, ay = p.y, bx = q.x, by = q.y, cx = r.x, cy = r.y;
        var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(d) < EPS) throw new Error('circle3: 3 points are collinear');
        var ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) +
                  (cx * cx + cy * cy) * (ay - by)) / d;
        var uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) +
                  (cx * cx + cy * cy) * (bx - ax)) / d;
        var center = P(ux, uy);
        var radius = dist(center, p);
        return Cir(center, radius);
    }

    function orthocenter(a, b, c) {
        // Altitude from A perpendicular to BC, altitude from B perpendicular to CA.
        // Solve their intersection.
        var d1x = -(c.y - b.y), d1y = (c.x - b.x);   // direction perpendicular to BC
        var d2x = -(a.y - c.y), d2y = (a.x - c.x);   // direction perpendicular to CA
        var det = d1x * (-d2y) - d1y * (-d2x);
        if (Math.abs(det) < EPS) throw new Error('orthocenter: degenerate triangle');
        var bx = b.x - a.x, by = b.y - a.y;
        var t = (bx * (-d2y) - by * (-d2x)) / det;
        return P(a.x + t * d1x, a.y + t * d1y);
    }

    function incenter(a, b, c) {
        var la = dist(b, c), lb = dist(c, a), lc = dist(a, b);
        var s = la + lb + lc;
        if (s < EPS) throw new Error('incenter: degenerate triangle');
        return P((la * a.x + lb * b.x + lc * c.x) / s,
                 (la * a.y + lb * b.y + lc * c.y) / s);
    }

    function centroid(a, b, c) {
        return P((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3);
    }

    function circumcenter(a, b, c) {
        return circleThrough(a, b, c).center;
    }

    function pointOnCircle(circle, angleDeg) {
        var rad = angleDeg * Math.PI / 180;
        return P(circle.center.x + circle.radius * Math.cos(rad),
                 circle.center.y + circle.radius * Math.sin(rad));
    }

    function intersectLineLine(a, b) {
        var x1 = a.p.x, y1 = a.p.y, x2 = a.q.x, y2 = a.q.y;
        var x3 = b.p.x, y3 = b.p.y, x4 = b.q.x, y4 = b.q.y;
        var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(den) < EPS) throw new Error('intersection: lines are parallel or coincident');
        var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
        return P(x1 + t * (x2 - x1), y1 + t * (y2 - y1));
    }

    function intersectLineCircle(line, circle, idx) {
        var dx = line.q.x - line.p.x, dy = line.q.y - line.p.y;
        var fx = line.p.x - circle.center.x, fy = line.p.y - circle.center.y;
        var aa = dx * dx + dy * dy;
        var bb = 2 * (fx * dx + fy * dy);
        var cc = fx * fx + fy * fy - circle.radius * circle.radius;
        var disc = bb * bb - 4 * aa * cc;
        if (disc < -EPS) throw new Error('intersection: line does not meet circle');
        if (disc < 0) disc = 0;
        var sq = Math.sqrt(disc);
        var t = (idx === 1) ? (-bb + sq) / (2 * aa) : (-bb - sq) / (2 * aa);
        return P(line.p.x + t * dx, line.p.y + t * dy);
    }

    function intersectCircleCircle(c1, c2, idx) {
        var d = dist(c1.center, c2.center);
        if (d > c1.radius + c2.radius + EPS || d < Math.abs(c1.radius - c2.radius) - EPS) {
            throw new Error('intersection: circles do not meet');
        }
        if (d < EPS) throw new Error('intersection: circles are concentric');
        var a = (c1.radius * c1.radius - c2.radius * c2.radius + d * d) / (2 * d);
        var h2 = c1.radius * c1.radius - a * a;
        var h = h2 > 0 ? Math.sqrt(h2) : 0;
        var px = c1.center.x + a * (c2.center.x - c1.center.x) / d;
        var py = c1.center.y + a * (c2.center.y - c1.center.y) / d;
        var ox = h * (c2.center.y - c1.center.y) / d;
        var oy = -h * (c2.center.x - c1.center.x) / d;
        return (idx === 1) ? P(px - ox, py - oy) : P(px + ox, py + oy);
    }

    function intersect(a, b, idx) {
        idx = idx | 0;
        if (isLinear(a) && isLinear(b))  return intersectLineLine(a, b);
        if (isLinear(a) && isCircle(b))  return intersectLineCircle(a, b, idx);
        if (isCircle(a) && isLinear(b))  return intersectLineCircle(b, a, idx);
        if (isCircle(a) && isCircle(b))  return intersectCircleCircle(a, b, idx);
        throw new Error('intersection: unsupported argument types');
    }

    function triangleFromSides(a, b, c) {
        if (a + b <= c + EPS || b + c <= a + EPS || c + a <= b + EPS) {
            throw new Error('triangle: sides ' + a + ',' + b + ',' + c +
                            ' violate the triangle inequality');
        }
        var A = P(0, 0);
        var B = P(c, 0);
        var cosA = (b * b + c * c - a * a) / (2 * b * c);
        if (cosA > 1) cosA = 1; if (cosA < -1) cosA = -1;
        var sinA = Math.sqrt(1 - cosA * cosA);
        var C = P(b * cosA, b * sinA);
        return Poly([A, B, C]);
    }

    function regularPolygon(center, vertex, n) {
        n = Math.round(n);
        if (n < 3) throw new Error('regular: n must be >= 3');
        var dx = vertex.x - center.x, dy = vertex.y - center.y;
        var pts = [];
        for (var k = 0; k < n; k++) {
            var ang = (2 * Math.PI * k) / n;
            var co = Math.cos(ang), si = Math.sin(ang);
            pts.push(P(center.x + dx * co - dy * si, center.y + dx * si + dy * co));
        }
        return Poly(pts);
    }

    // ---- transformations ----
    function mapPoints(obj, fn) {
        if (isPoint(obj))   return fn(obj);
        if (isVector(obj))  return obj;  // vectors are not transformed by translate; rotate/scale below handle
        if (isLinear(obj))  return { kind: obj.kind, p: fn(obj.p), q: fn(obj.q) };
        if (isCircle(obj))  return Cir(fn(obj.center), obj.radius);
        if (obj.kind === 'arc') return Arc_(fn(obj.center), obj.radius, obj.start, obj.end);
        if (isPolygon(obj)) return Poly(obj.points.map(fn));
        throw new Error('transform: unsupported object kind ' + obj.kind);
    }

    function translateObj(obj, v) {
        if (!isVector(v)) throw new Error('translate: second arg must be a vector');
        return mapPoints(obj, function (pt) { return P(pt.x + v.x, pt.y + v.y); });
    }

    function rotateObj(obj, center, angleDeg) {
        if (!isPoint(center)) throw new Error('rotate: center must be a point');
        var rad = angleDeg * Math.PI / 180;
        var co = Math.cos(rad), si = Math.sin(rad);
        // For circles, radius is preserved; rotate the center only via mapPoints.
        if (isCircle(obj) || obj.kind === 'arc') {
            // arc start/end angles also rotate
            var rotated = mapPoints(obj, function (pt) {
                var dx = pt.x - center.x, dy = pt.y - center.y;
                return P(center.x + dx * co - dy * si, center.y + dx * si + dy * co);
            });
            if (obj.kind === 'arc') {
                rotated.start = obj.start + angleDeg;
                rotated.end = obj.end + angleDeg;
            }
            return rotated;
        }
        return mapPoints(obj, function (pt) {
            var dx = pt.x - center.x, dy = pt.y - center.y;
            return P(center.x + dx * co - dy * si, center.y + dx * si + dy * co);
        });
    }

    function reflectObj(obj, line) {
        if (!isLinear(line)) throw new Error('reflect: second arg must be a line');
        return mapPoints(obj, function (pt) {
            var f = footOnLine(pt, line.p, line.q);
            return P(2 * f.x - pt.x, 2 * f.y - pt.y);
        });
    }

    function scaleObj(obj, center, factor) {
        if (!isPoint(center)) throw new Error('scale: center must be a point');
        if (!isNum(factor)) throw new Error('scale: factor must be a number');
        var f = factor;
        var out = mapPoints(obj, function (pt) {
            return P(center.x + f * (pt.x - center.x), center.y + f * (pt.y - center.y));
        });
        if (isCircle(out)) out.radius = obj.radius * Math.abs(f);
        return out;
    }

    // ============ Built-in dispatch ============

    function expectNum(v, n) {
        if (!isNum(v)) throw new Error(n + ': expected a number');
        return v;
    }
    function expectPoint(v, n) {
        if (!isPoint(v)) throw new Error(n + ': expected a point');
        return v;
    }
    function expectVector(v, n) {
        if (!isVector(v)) throw new Error(n + ': expected a vector');
        return v;
    }
    function expectLine(v, n) {
        if (!isLinear(v)) throw new Error(n + ': expected a line/segment/ray');
        return v;
    }
    function expectCircle(v, n) {
        if (!isCircle(v)) throw new Error(n + ': expected a circle');
        return v;
    }

    var BUILTINS = {
        point: function (args) {
            if (args.length !== 2) throw new Error('point: needs 2 numbers');
            return P(expectNum(args[0], 'point'), expectNum(args[1], 'point'));
        },
        vector: function (args) {
            if (args.length === 2) return V(expectNum(args[0], 'vector'), expectNum(args[1], 'vector'));
            throw new Error('vector: needs 2 numbers');
        },
        vector_from: function (args) {
            if (args.length !== 2) throw new Error('vector_from: needs 2 points');
            var a = expectPoint(args[0], 'vector_from'), b = expectPoint(args[1], 'vector_from');
            return V(b.x - a.x, b.y - a.y);
        },
        distance: function (args) {
            return dist(expectPoint(args[0], 'distance'), expectPoint(args[1], 'distance'));
        },
        segment: function (args) {
            return Seg(expectPoint(args[0], 'segment'), expectPoint(args[1], 'segment'));
        },
        line: function (args) {
            return Lin(expectPoint(args[0], 'line'), expectPoint(args[1], 'line'));
        },
        ray: function (args) {
            return Ray_(expectPoint(args[0], 'ray'), expectPoint(args[1], 'ray'));
        },
        circle: function (args) {
            return Cir(expectPoint(args[0], 'circle'), expectNum(args[1], 'circle'));
        },
        circle3: function (args) {
            return circleThrough(expectPoint(args[0], 'circle3'),
                                 expectPoint(args[1], 'circle3'),
                                 expectPoint(args[2], 'circle3'));
        },
        circle_diameter: function (args) {
            var p = expectPoint(args[0], 'circle_diameter');
            var q = expectPoint(args[1], 'circle_diameter');
            return Cir(midpoint(p, q), dist(p, q) / 2);
        },
        arc: function (args) {
            return Arc_(expectPoint(args[0], 'arc'),
                        expectNum(args[1], 'arc'),
                        expectNum(args[2], 'arc'),
                        expectNum(args[3], 'arc'));
        },
        polygon: function (args) {
            if (args.length < 3) throw new Error('polygon: needs >= 3 points');
            for (var i = 0; i < args.length; i++) expectPoint(args[i], 'polygon');
            return Poly(args.slice());
        },
        triangle: function (args) {
            if (args.length === 0) return triangleFromSides(5, 4, 6);
            if (args.length === 3 && args.every(isPoint)) return Poly(args.slice());
            if (args.length === 3 && args.every(isNum))
                return triangleFromSides(args[0], args[1], args[2]);
            throw new Error('triangle: bad arguments (needs 0 args, 3 points, or 3 numbers)');
        },
        regular: function (args) {
            return regularPolygon(expectPoint(args[0], 'regular'),
                                  expectPoint(args[1], 'regular'),
                                  expectNum(args[2], 'regular'));
        },
        midpoint: function (args) {
            return midpoint(expectPoint(args[0], 'midpoint'), expectPoint(args[1], 'midpoint'));
        },
        foot: function (args) {
            // foot(P, A, B) or foot(P, line)
            if (args.length === 3) {
                return footOnLine(expectPoint(args[0], 'foot'),
                                  expectPoint(args[1], 'foot'),
                                  expectPoint(args[2], 'foot'));
            }
            if (args.length === 2 && isPoint(args[0]) && isLinear(args[1])) {
                return footOnLine(args[0], args[1].p, args[1].q);
            }
            throw new Error('foot: needs (point, A, B) or (point, line)');
        },
        intersection: function (args) {
            return intersect(args[0], args[1], args[2] || 0);
        },
        orthocenter: function (args) {
            return orthocenter(expectPoint(args[0], 'orthocenter'),
                               expectPoint(args[1], 'orthocenter'),
                               expectPoint(args[2], 'orthocenter'));
        },
        circumcenter: function (args) {
            return circumcenter(expectPoint(args[0], 'circumcenter'),
                                expectPoint(args[1], 'circumcenter'),
                                expectPoint(args[2], 'circumcenter'));
        },
        incenter: function (args) {
            return incenter(expectPoint(args[0], 'incenter'),
                            expectPoint(args[1], 'incenter'),
                            expectPoint(args[2], 'incenter'));
        },
        centroid: function (args) {
            return centroid(expectPoint(args[0], 'centroid'),
                            expectPoint(args[1], 'centroid'),
                            expectPoint(args[2], 'centroid'));
        },
        point_on: function (args) {
            return pointOnCircle(expectCircle(args[0], 'point_on'),
                                 expectNum(args[1], 'point_on'));
        },
        translate: function (args) {
            return translateObj(args[0], expectVector(args[1], 'translate'));
        },
        rotate: function (args) {
            return rotateObj(args[0], expectPoint(args[1], 'rotate'),
                             expectNum(args[2], 'rotate'));
        },
        reflect: function (args) {
            return reflectObj(args[0], expectLine(args[1], 'reflect'));
        },
        scale: function (args) {
            return scaleObj(args[0], expectPoint(args[1], 'scale'),
                            expectNum(args[2], 'scale'));
        },
        radians: function (args) { return expectNum(args[0], 'radians') * Math.PI / 180; },
        // Mark constructors are returned as opaque markers that the renderer interprets.
        right_angle: function (args) {
            return { kind: 'mark_right_angle',
                     a: expectPoint(args[0], 'right_angle'),
                     vertex: expectPoint(args[1], 'right_angle'),
                     c: expectPoint(args[2], 'right_angle') };
        },
        angle: function (args) {
            return { kind: 'mark_angle',
                     a: expectPoint(args[0], 'angle'),
                     vertex: expectPoint(args[1], 'angle'),
                     c: expectPoint(args[2], 'angle') };
        },
        tick: function (args) {
            // tick(segment)
            return { kind: 'mark_tick', segment: expectLine(args[0], 'tick') };
        }
    };

    // ============ Evaluator ============

    function evalNode(node, env) {
        switch (node.kind) {
            case 'num': return node.value;
            case 'str': return node.value;
            case 'hex': return node.value;   // colors travel as strings
            case 'neg': {
                var v = evalNode(node.value, env);
                if (!isNum(v)) throw new Error('Line ' + node.line + ': unary minus needs a number');
                return -v;
            }
            case 'binop': {
                var lv = evalNode(node.left, env), rv = evalNode(node.right, env);
                if (!isNum(lv) || !isNum(rv))
                    throw new Error('Line ' + node.line + ': arithmetic requires numbers');
                switch (node.op) {
                    case TOK.PLUS:  return lv + rv;
                    case TOK.MINUS: return lv - rv;
                    case TOK.STAR:  return lv * rv;
                    case TOK.SLASH:
                        if (Math.abs(rv) < EPS) throw new Error('Line ' + node.line + ': divide by zero');
                        return lv / rv;
                }
                throw new Error('Line ' + node.line + ': unknown operator');
            }
            case 'var': {
                if (!(node.name in env))
                    throw new Error('Line ' + node.line + ': undefined name `' + node.name + '`');
                return env[node.name];
            }
            case 'member': {
                var obj = evalNode(node.object, env);
                return getMember(obj, node.name, node.line);
            }
            case 'call': {
                var fn = BUILTINS[node.name];
                if (!fn) throw new Error('Line ' + node.line + ': unknown function `' + node.name + '`');
                var args = node.args.map(function (a) {
                    if (a.kw) throw new Error('Line ' + node.line + ': keyword args not supported in `' +
                                              node.name + '`');
                    return evalNode(a.value, env);
                });
                try {
                    return fn(args);
                } catch (e) {
                    throw new Error('Line ' + node.line + ': ' + e.message);
                }
            }
        }
        throw new Error('eval: unknown node kind ' + node.kind);
    }

    // Member access on polygons of 3 points (triangle convenience).
    // T.A T.B T.C  -> vertices  (0, 1, 2)
    // T.AB T.BC T.CA -> sides
    function getMember(obj, name, line) {
        if (isPolygon(obj) && obj.points.length === 3) {
            var pts = obj.points;
            var V0 = pts[0], V1 = pts[1], V2 = pts[2];
            switch (name) {
                case 'A': return V0;
                case 'B': return V1;
                case 'C': return V2;
                case 'AB': return Seg(V0, V1);
                case 'BC': return Seg(V1, V2);
                case 'CA': return Seg(V2, V0);
                case 'BA': return Seg(V1, V0);
                case 'CB': return Seg(V2, V1);
                case 'AC': return Seg(V0, V2);
            }
        }
        if (isCircle(obj)) {
            if (name === 'center') return obj.center;
            if (name === 'radius') return obj.radius;
        }
        if (isLinear(obj)) {
            if (name === 'p') return obj.p;
            if (name === 'q') return obj.q;
        }
        if (isPoint(obj)) {
            if (name === 'x') return obj.x;
            if (name === 'y') return obj.y;
        }
        throw new Error('Line ' + line + ': member `' + name + '` not available on ' + (obj && obj.kind));
    }

    // ============ Setting parser ============
    // Settings hold their raw token list; we re-interpret per-key.

    function parseSetting(key, raw) {
        function num(tok) {
            if (!tok) throw new Error('setting `' + key + '`: missing value');
            if (tok.type === TOK.NUM) return tok.value;
            if (tok.type === TOK.MINUS) return null;  // signal: combine with next
            throw new Error('setting `' + key + '`: expected number, got ' + tok.type);
        }
        // Reduce raw tokens to a list of numbers (handling unary minus) or idents.
        var nums = [];
        var idents = [];
        for (var i = 0; i < raw.length; i++) {
            if (raw[i].type === TOK.MINUS && raw[i + 1] && raw[i + 1].type === TOK.NUM) {
                nums.push(-raw[i + 1].value);
                i++;
            } else if (raw[i].type === TOK.NUM) {
                nums.push(raw[i].value);
            } else if (raw[i].type === TOK.IDENT) {
                idents.push(raw[i].value);
            }
        }
        switch (key) {
            case 'viewport':
                if (nums.length !== 4) throw new Error('viewport: needs 4 numbers (xmin ymin xmax ymax)');
                return { viewport: { xmin: nums[0], ymin: nums[1], xmax: nums[2], ymax: nums[3] } };
            case 'unit':
                if (nums.length !== 1) throw new Error('unit: needs 1 number');
                return { unit: nums[0] };
            case 'grid':
                if (idents.length !== 1) throw new Error('grid: needs `on` or `off`');
                return { grid: idents[0] === 'on' };
            case 'axes':
                if (idents.length !== 1) throw new Error('axes: needs `on` or `off`');
                return { axes: idents[0] === 'on' };
            case 'mode':
                // 3d is reserved for the future; ignore with a soft no-op.
                return {};
            default:
                throw new Error('unknown setting: `' + key + '`');
        }
    }

    // ============ Bounding box ============

    function expandBBox(bb, x, y) {
        if (x < bb.xmin) bb.xmin = x;
        if (y < bb.ymin) bb.ymin = y;
        if (x > bb.xmax) bb.xmax = x;
        if (y > bb.ymax) bb.ymax = y;
    }

    function expandWithObj(bb, obj) {
        if (!obj) return;
        if (isPoint(obj))   { expandBBox(bb, obj.x, obj.y); return; }
        if (isLinear(obj))  { expandBBox(bb, obj.p.x, obj.p.y); expandBBox(bb, obj.q.x, obj.q.y); return; }
        if (isCircle(obj))  {
            expandBBox(bb, obj.center.x - obj.radius, obj.center.y - obj.radius);
            expandBBox(bb, obj.center.x + obj.radius, obj.center.y + obj.radius);
            return;
        }
        if (isPolygon(obj)) { obj.points.forEach(function (p) { expandBBox(bb, p.x, p.y); }); return; }
        if (obj.kind === 'arc') {
            expandBBox(bb, obj.center.x - obj.radius, obj.center.y - obj.radius);
            expandBBox(bb, obj.center.x + obj.radius, obj.center.y + obj.radius);
        }
    }

    // ============ SVG rendering ============

    function resolveColor(c) {
        if (!c) return null;
        if (typeof c !== 'string') return null;
        // Hex literals come in as `#xxx[xx[xx]]`
        if (c[0] === '#') return c;
        // Allow a handful of named colors plus arbitrary CSS names by passthrough.
        return c;
    }

    function styleAttrs(styles) {
        styles = styles || {};
        var stroke = resolveColor(styles.color || styles.stroke);
        var fill = resolveColor(styles.fill);
        var thickness = isNum(styles.thickness) ? styles.thickness :
                        (styles.thick ? 2.0 : (styles.thin ? 0.7 : 1.2));
        var dashArray = null;
        if (styles.dashed) dashArray = '5 4';
        else if (styles.dotted) dashArray = '1.5 3';
        return {
            stroke: stroke || 'currentColor',
            fill: fill || 'none',
            strokeWidth: thickness,
            dashArray: dashArray,
            hidden: !!styles.hidden
        };
    }

    function pointStyleAttrs(styles) {
        styles = styles || {};
        var stroke = resolveColor(styles.color || styles.stroke) || 'currentColor';
        var fill = resolveColor(styles.fill) || stroke;
        return { stroke: stroke, fill: fill, hidden: !!styles.hidden };
    }

    // Clip an infinite line p-q to a rect [xmin..xmax] x [ymin..ymax] (Liang-Barsky).
    function clipLineToRect(p, q, rect) {
        var dx = q.x - p.x, dy = q.y - p.y;
        var t0 = -Infinity, t1 = Infinity;
        var ps = [-dx, dx, -dy, dy];
        var qs = [p.x - rect.xmin, rect.xmax - p.x, p.y - rect.ymin, rect.ymax - p.y];
        for (var i = 0; i < 4; i++) {
            if (Math.abs(ps[i]) < EPS) {
                if (qs[i] < 0) return null;
            } else {
                var t = qs[i] / ps[i];
                if (ps[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
                else            { if (t < t0) return null; if (t < t1) t1 = t; }
            }
        }
        return {
            p1: P(p.x + t0 * dx, p.y + t0 * dy),
            p2: P(p.x + t1 * dx, p.y + t1 * dy)
        };
    }

    // Coordinate transform: world (math: y up) -> SVG (y down).
    // We use a viewBox covering the world rect and apply a negative y-scale
    // via a wrapping <g transform>, so all primitives can be authored in
    // natural math coordinates.

    function renderDocument(stmts) {
        // Pass 1: evaluate all statements, collecting bindings, draw queue, labels, marks.
        var env = {};
        var settings = { unit: 40, grid: false, axes: false, viewport: null };
        var drawQueue = [];   // { obj, styles, line }
        var labels = [];      // { target, text, pos, offset, line }
        var marks = [];       // { mark, styles, line }

        for (var i = 0; i < stmts.length; i++) {
            var st = stmts[i];
            try {
                if (st.kind === 'setting') {
                    var partial = parseSetting(st.key, st.raw);
                    for (var k in partial) settings[k] = partial[k];
                } else if (st.kind === 'assign') {
                    env[st.name] = evalNode(st.value, env);
                } else if (st.kind === 'draw') {
                    var v = evalNode(st.expr, env);
                    drawQueue.push({ obj: v, styles: st.styles, line: st.line });
                } else if (st.kind === 'label') {
                    var target = evalNode(st.target, env);
                    var pos = (st.styles && st.styles.pos) ? String(st.styles.pos).toUpperCase() : 'NE';
                    var off = isNum(st.styles && st.styles.offset) ? st.styles.offset : null;
                    labels.push({ target: target, text: st.text, pos: pos, offset: off,
                                  styles: st.styles, line: st.line });
                } else if (st.kind === 'mark') {
                    var m = evalNode(st.expr, env);
                    if (!m || typeof m !== 'object' || !/^mark_/.test(m.kind || ''))
                        throw new Error('Line ' + st.line + ': mark expects right_angle/angle/tick(...)');
                    marks.push({ mark: m, styles: st.styles, line: st.line });
                }
            } catch (e) {
                throw new Error(e.message);
            }
        }

        // Pass 2: compute viewport if not explicit.
        var vp = settings.viewport;
        if (!vp) {
            var bb = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
            drawQueue.forEach(function (d) { expandWithObj(bb, d.obj); });
            labels.forEach(function (l) { expandWithObj(bb, l.target); });
            // Include named bindings that are points (so labels never go off-screen even
            // if the point itself wasn't drawn)
            for (var nm in env) expandWithObj(bb, env[nm]);
            if (!isFinite(bb.xmin)) {
                bb = { xmin: -1, ymin: -1, xmax: 1, ymax: 1 };
            }
            var pad = Math.max((bb.xmax - bb.xmin), (bb.ymax - bb.ymin)) * 0.1 || 1;
            vp = { xmin: bb.xmin - pad, ymin: bb.ymin - pad,
                   xmax: bb.xmax + pad, ymax: bb.ymax + pad };
        }
        var vpW = vp.xmax - vp.xmin, vpH = vp.ymax - vp.ymin;
        if (vpW < EPS || vpH < EPS) { vp.xmax = vp.xmin + 1; vp.ymax = vp.ymin + 1; vpW = vpH = 1; }
        var unit = settings.unit;
        var pxW = vpW * unit, pxH = vpH * unit;

        // Pass 3: emit SVG.
        // Choose font size relative to unit so labels stay readable across viewport scales.
        var fontSize = Math.max(11, Math.min(unit * 0.34, 18));
        var pointRadiusPx = 3.2;
        // World stroke-width = pixel width / unit (so we can author in world units).
        var worldStroke = function (px) { return px / unit; };

        var out = [];
        out.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
                 vp.xmin + ' ' + (-vp.ymax) + ' ' + vpW + ' ' + vpH +
                 '" width="' + pxW.toFixed(1) + '" height="' + pxH.toFixed(1) +
                 '" class="kataskeve-svg" style="font-family: \'Latin Modern Math\', \'STIX Two Math\', \'Cambria Math\', Cambria, Georgia, serif;">');
        // Flip y so positive world-y points up.
        out.push('<g transform="scale(1, -1)">');

        // Background grid (light)
        if (settings.grid) {
            var step = 1;
            var range = Math.max(vpW, vpH);
            if (range > 20) step = 5;
            else if (range > 10) step = 2;
            var gridColor = isDark() ? '#3a3a3a' : '#e0e0e0';
            var sw = worldStroke(0.6);
            var startX = Math.ceil(vp.xmin / step) * step;
            for (var gx = startX; gx <= vp.xmax + EPS; gx += step) {
                out.push('<line x1="' + gx + '" y1="' + vp.ymin + '" x2="' + gx +
                         '" y2="' + vp.ymax + '" stroke="' + gridColor + '" stroke-width="' + sw + '"/>');
            }
            var startY = Math.ceil(vp.ymin / step) * step;
            for (var gy = startY; gy <= vp.ymax + EPS; gy += step) {
                out.push('<line x1="' + vp.xmin + '" y1="' + gy + '" x2="' + vp.xmax +
                         '" y2="' + gy + '" stroke="' + gridColor + '" stroke-width="' + sw + '"/>');
            }
        }
        // Axes
        if (settings.axes) {
            var axisColor = isDark() ? '#888' : '#777';
            var asw = worldStroke(1);
            if (vp.ymin <= 0 && vp.ymax >= 0) {
                out.push('<line x1="' + vp.xmin + '" y1="0" x2="' + vp.xmax + '" y2="0" stroke="' +
                         axisColor + '" stroke-width="' + asw + '"/>');
            }
            if (vp.xmin <= 0 && vp.xmax >= 0) {
                out.push('<line x1="0" y1="' + vp.ymin + '" x2="0" y2="' + vp.ymax + '" stroke="' +
                         axisColor + '" stroke-width="' + asw + '"/>');
            }
        }

        // Draw objects in declaration order
        drawQueue.forEach(function (d) {
            var s = styleAttrs(d.styles);
            if (s.hidden) return;
            emitObject(out, d.obj, d.styles, s, vp, worldStroke);
        });

        // Marks (right_angle, angle, tick)
        marks.forEach(function (m) {
            emitMark(out, m.mark, m.styles, vp, worldStroke);
        });

        out.push('</g>');  // end y-flip

        // Labels: rendered in un-flipped space so text isn't mirrored.
        // Convert each label target's world coord to SVG (un-flipped) coord.
        labels.forEach(function (l) {
            var anchor = labelAnchor(l.target);
            if (!anchor) return;
            // World y -> SVG y: SVG y = -world_y (because viewBox is set with -ymax origin
            // and total height vpH).
            var sx = anchor.x;
            var sy = -anchor.y;
            var offPx = l.offset != null ? l.offset : 8;
            var off = offPx / unit;  // back to world distance for compatibility
            var dx = 0, dy = 0;
            var anchorAttr = 'middle';
            var baseline = 'middle';
            switch (l.pos) {
                case 'N':  dy = -off; baseline = 'baseline'; break;
                case 'S':  dy =  off; baseline = 'hanging';  break;
                case 'E':  dx =  off; anchorAttr = 'start';  break;
                case 'W':  dx = -off; anchorAttr = 'end';    break;
                case 'NE': dx =  off; dy = -off; anchorAttr = 'start'; baseline = 'baseline'; break;
                case 'NW': dx = -off; dy = -off; anchorAttr = 'end';   baseline = 'baseline'; break;
                case 'SE': dx =  off; dy =  off; anchorAttr = 'start'; baseline = 'hanging';  break;
                case 'SW': dx = -off; dy =  off; anchorAttr = 'end';   baseline = 'hanging';  break;
                default: dx = off; dy = -off; anchorAttr = 'start'; baseline = 'baseline';
            }
            // Convert dx/dy from world to label-space (un-flipped svg). dx is already
            // x-positive; dy here is "screen down = positive", which matches un-flipped svg.
            var tx = sx + dx;
            var ty = sy + dy;
            var color = resolveColor((l.styles && (l.styles.color || l.styles.stroke))) || 'currentColor';
            out.push('<text x="' + tx.toFixed(4) + '" y="' + ty.toFixed(4) +
                     '" font-size="' + fontSize / unit + '" text-anchor="' + anchorAttr +
                     '" dominant-baseline="' + baseline + '" fill="' + color + '">' +
                     escapeXml(l.text) + '</text>');
        });

        out.push('</svg>');
        return out.join('');

        function labelAnchor(obj) {
            if (isPoint(obj)) return obj;
            if (isLinear(obj)) return P((obj.p.x + obj.q.x) / 2, (obj.p.y + obj.q.y) / 2);
            if (isCircle(obj)) return P(obj.center.x, obj.center.y + obj.radius);
            if (isPolygon(obj)) {
                var sx = 0, sy = 0;
                obj.points.forEach(function (p) { sx += p.x; sy += p.y; });
                return P(sx / obj.points.length, sy / obj.points.length);
            }
            return null;
        }
    }

    function emitObject(out, obj, rawStyles, s, vp, worldStroke) {
        var dashAttr = s.dashArray ? ' stroke-dasharray="' + s.dashArray.split(' ')
                                       .map(function (v) { return worldStroke(parseFloat(v)).toFixed(4); }).join(' ') + '"'
                                   : '';
        var sw = worldStroke(s.strokeWidth);
        var strokeA = ' stroke="' + s.stroke + '" stroke-width="' + sw + '"' + dashAttr;
        var fillA = ' fill="' + s.fill + '"';

        if (isPoint(obj)) {
            var ps = pointStyleAttrs(rawStyles);
            // Point glyph: a fixed-pixel-radius filled dot (in world units = px/unit).
            var r = worldStroke(3.2);
            out.push('<circle cx="' + obj.x + '" cy="' + obj.y +
                     '" r="' + r + '" stroke="' + ps.stroke + '" fill="' + ps.fill +
                     '" stroke-width="' + worldStroke(0.8) + '"/>');
            return;
        }

        if (obj.kind === 'segment') {
            out.push('<line x1="' + obj.p.x + '" y1="' + obj.p.y +
                     '" x2="' + obj.q.x + '" y2="' + obj.q.y + '"' + strokeA + '/>');
            return;
        }

        if (obj.kind === 'line') {
            var clipped = clipLineToRect(obj.p, obj.q,
                { xmin: vp.xmin, ymin: vp.ymin, xmax: vp.xmax, ymax: vp.ymax });
            if (!clipped) return;
            out.push('<line x1="' + clipped.p1.x + '" y1="' + clipped.p1.y +
                     '" x2="' + clipped.p2.x + '" y2="' + clipped.p2.y + '"' + strokeA + '/>');
            return;
        }

        if (obj.kind === 'ray') {
            // Extend from p through q to the viewport boundary.
            var dx = obj.q.x - obj.p.x, dy = obj.q.y - obj.p.y;
            if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return;
            var far = P(obj.p.x + dx * 1e6, obj.p.y + dy * 1e6);
            var clip = clipLineToRect(obj.p, far,
                { xmin: vp.xmin, ymin: vp.ymin, xmax: vp.xmax, ymax: vp.ymax });
            if (!clip) return;
            out.push('<line x1="' + obj.p.x + '" y1="' + obj.p.y +
                     '" x2="' + clip.p2.x + '" y2="' + clip.p2.y + '"' + strokeA + '/>');
            return;
        }

        if (isCircle(obj)) {
            out.push('<circle cx="' + obj.center.x + '" cy="' + obj.center.y +
                     '" r="' + obj.radius + '"' + strokeA + fillA + '/>');
            return;
        }

        if (obj.kind === 'arc') {
            var s0 = obj.start * Math.PI / 180, e0 = obj.end * Math.PI / 180;
            var ax = obj.center.x + obj.radius * Math.cos(s0);
            var ay = obj.center.y + obj.radius * Math.sin(s0);
            var bx = obj.center.x + obj.radius * Math.cos(e0);
            var by = obj.center.y + obj.radius * Math.sin(e0);
            var sweep = obj.end > obj.start ? 1 : 0;  // SVG: in user space; under y-flip this stays consistent for CCW
            var large = Math.abs(obj.end - obj.start) > 180 ? 1 : 0;
            out.push('<path d="M ' + ax + ' ' + ay + ' A ' + obj.radius + ' ' + obj.radius +
                     ' 0 ' + large + ' ' + sweep + ' ' + bx + ' ' + by + '"' + strokeA + ' fill="none"/>');
            return;
        }

        if (isPolygon(obj)) {
            var pts = obj.points.map(function (p) { return p.x + ',' + p.y; }).join(' ');
            out.push('<polygon points="' + pts + '"' + strokeA + fillA + '/>');
            return;
        }
    }

    function emitMark(out, m, styles, vp, worldStroke) {
        var color = resolveColor(styles && (styles.color || styles.stroke)) || 'currentColor';
        var sw = worldStroke(1.0);
        if (m.kind === 'mark_right_angle') {
            // Draw a small square at the vertex along the bisector of the perpendicular legs.
            var v = m.vertex, a = m.a, c = m.c;
            var size = (isNum(styles && styles.size) ? styles.size : 0.22);
            // Unit vectors along v->a and v->c
            var d1 = norm(V(a.x - v.x, a.y - v.y));
            var d2 = norm(V(c.x - v.x, c.y - v.y));
            if (!d1 || !d2) return;
            var p1 = P(v.x + size * d1.x, v.y + size * d1.y);
            var p2 = P(v.x + size * (d1.x + d2.x), v.y + size * (d1.y + d2.y));
            var p3 = P(v.x + size * d2.x, v.y + size * d2.y);
            out.push('<path d="M ' + p1.x + ' ' + p1.y + ' L ' + p2.x + ' ' + p2.y +
                     ' L ' + p3.x + ' ' + p3.y + '" stroke="' + color +
                     '" stroke-width="' + sw + '" fill="none"/>');
            return;
        }
        if (m.kind === 'mark_angle') {
            var v2 = m.vertex, a2 = m.a, c2 = m.c;
            var radius = (isNum(styles && styles.radius) ? styles.radius : 0.45);
            var arcs = Math.max(1, Math.round(styles && styles.arcs || 1));
            var angA = Math.atan2(a2.y - v2.y, a2.x - v2.x);
            var angC = Math.atan2(c2.y - v2.y, c2.x - v2.x);
            // Draw arc from angA to angC the short way
            var delta = angC - angA;
            while (delta > Math.PI) delta -= 2 * Math.PI;
            while (delta < -Math.PI) delta += 2 * Math.PI;
            var sweep = delta > 0 ? 1 : 0;
            for (var i = 0; i < arcs; i++) {
                var R = radius + i * 0.08;
                var ax2 = v2.x + R * Math.cos(angA);
                var ay2 = v2.y + R * Math.sin(angA);
                var bx2 = v2.x + R * Math.cos(angA + delta);
                var by2 = v2.y + R * Math.sin(angA + delta);
                out.push('<path d="M ' + ax2 + ' ' + ay2 + ' A ' + R + ' ' + R +
                         ' 0 0 ' + sweep + ' ' + bx2 + ' ' + by2 +
                         '" stroke="' + color + '" stroke-width="' + sw + '" fill="none"/>');
            }
            return;
        }
        if (m.kind === 'mark_tick') {
            var seg = m.segment;
            var mid = midpoint(seg.p, seg.q);
            var dir = norm(V(seg.q.x - seg.p.x, seg.q.y - seg.p.y));
            if (!dir) return;
            var perp = V(-dir.y, dir.x);
            var count = Math.max(1, Math.round(styles && styles.count || 1));
            var tickHalf = 0.12;
            var gap = 0.08;
            for (var k = 0; k < count; k++) {
                var t = (k - (count - 1) / 2) * gap;
                var cx = mid.x + dir.x * t, cy = mid.y + dir.y * t;
                out.push('<line x1="' + (cx - perp.x * tickHalf) + '" y1="' + (cy - perp.y * tickHalf) +
                         '" x2="' + (cx + perp.x * tickHalf) + '" y2="' + (cy + perp.y * tickHalf) +
                         '" stroke="' + color + '" stroke-width="' + sw + '"/>');
            }
            return;
        }
    }

    function norm(v) {
        var L = Math.hypot(v.x, v.y);
        if (L < EPS) return null;
        return V(v.x / L, v.y / L);
    }

    // ============ Public API ============

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function render(source) {
        try {
            var stmts = parse(source);
            return renderDocument(stmts);
        } catch (e) {
            return '<div class="kataskeve-error">Kataskeve error: ' + escapeHtml(e.message) + '</div>';
        }
    }

    function renderAll(container) {
        if (!container) return;
        var blocks = container.querySelectorAll('[data-kataskeve]');
        blocks.forEach(function (el) {
            var src;
            try { src = decodeURIComponent(el.getAttribute('data-kataskeve-source') || ''); }
            catch (e) { src = el.textContent || ''; }
            el.innerHTML = render(src);
        });
    }

    global.Kataskeve = {
        render: render,
        renderAll: renderAll,
        parse: parse
    };
})(typeof window !== 'undefined' ? window : this);
