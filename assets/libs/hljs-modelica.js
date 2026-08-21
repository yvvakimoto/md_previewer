/*
 * Modelica language definition for highlight.js  (in-house, hand-written)
 *
 * Loaded by assets/index.html immediately after libs/highlight.js/highlight.min.js
 * and self-registers as the `modelica` language (aliases: `mo`, `mos`).
 *
 * Why hand-written rather than fetched by tools/fetch-libs.ps1:
 *   - highlight.js core ships no Modelica grammar — it is absent from the
 *     `languages/` set cdnjs/jsdelivr publish for 11.x, common or otherwise.
 *   - The npm plugin `highlightjs-modelica` targets hljs v9/v10: its `contains`
 *     ends in `hljs.METHOD_GUARD`, which v11 removed, so compiling it against
 *     the bundled 11.9.0 throws. It also treats `'...'` as a string, whereas in
 *     Modelica single quotes delimit a *quoted identifier* (Q-IDENT), and it
 *     lists `extends` / `partial` / `within` as built-ins rather than keywords.
 * So this file is in-house source, tracked in git: the .gitignore policy
 * enumerates each generated artifact under assets/libs/ explicitly, so a
 * hand-written file here is tracked by default. It needs no
 * THIRD_PARTY_LICENSES entry for the same reason.
 *
 * Keyword sets follow the Modelica Language Specification 3.6 (reserved words,
 * built-in functions, built-in types).
 */
(function () {
    'use strict';

    function modelica(hljs) {
        const KEYWORDS = {
            keyword: [
                'algorithm', 'and', 'annotation', 'block', 'break', 'class', 'connect',
                'connector', 'constant', 'constrainedby', 'der', 'discrete', 'each',
                'else', 'elseif', 'elsewhen', 'encapsulated', 'end', 'enumeration',
                'equation', 'expandable', 'extends', 'external', 'final', 'flow', 'for',
                'function', 'if', 'import', 'impure', 'in', 'initial', 'inner', 'input',
                'loop', 'model', 'not', 'operator', 'or', 'outer', 'output', 'package',
                'parameter', 'partial', 'protected', 'public', 'pure', 'record',
                'redeclare', 'replaceable', 'return', 'stream', 'then', 'type', 'when',
                'while', 'within'
            ],
            literal: ['true', 'false'],
            type: [
                'Real', 'Integer', 'Boolean', 'String', 'Clock',
                'StateSelect', 'ExternalObject', 'AssertionLevel'
            ],
            built_in: [
                // math / conversion
                'abs', 'sign', 'sqrt', 'div', 'mod', 'rem', 'ceil', 'floor', 'integer',
                'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh',
                'tanh', 'exp', 'log', 'log10',
                // event / time / diagnostics
                'pre', 'edge', 'change', 'reinit', 'sample', 'terminal', 'noEvent',
                'smooth', 'terminate', 'assert', 'delay', 'cardinality', 'homotopy',
                'semiLinear', 'spatialDistribution', 'getInstanceName',
                // connector / stream
                'inStream', 'actualStream', 'Connections',
                // array
                'size', 'ndims', 'scalar', 'vector', 'matrix', 'transpose',
                'outerProduct', 'identity', 'diagonal', 'zeros', 'ones', 'fill',
                'linspace', 'min', 'max', 'sum', 'product', 'symmetric', 'cross',
                'skew', 'cat',
                // synchronous / clocked (Modelica 3.3+)
                'previous', 'hold', 'subSample', 'superSample', 'shiftSample',
                'backSample', 'noClock', 'interval'
            ]
        };

        // A Modelica string may span lines (documentation / annotation text), so
        // this is deliberately NOT hljs.QUOTE_STRING_MODE, which sets illegal: \n.
        const STRING = {
            scope: 'string',
            begin: '"',
            end: '"',
            contains: [hljs.BACKSLASH_ESCAPE]
        };

        // Q-IDENT: '...' is an *identifier* in Modelica, not a string literal.
        const QUOTED_IDENT = {
            scope: 'symbol',
            begin: /'[^'\n]*'/,
            relevance: 0
        };

        const NUMBER = {
            scope: 'number',
            begin: /\b\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/,
            relevance: 0
        };

        return {
            name: 'Modelica',
            aliases: ['mo', 'mos'],
            keywords: KEYWORDS,
            contains: [
                hljs.C_LINE_COMMENT_MODE,
                hljs.C_BLOCK_COMMENT_MODE,
                STRING,
                QUOTED_IDENT,
                // `model Foo`, `partial record Bar`, `operator record Complex`, …
                // The third group refuses `record` / `function` so that the
                // two-word `operator record` / `operator function` forms fail
                // here and re-match on their second word, naming the class
                // rather than the qualifier.
                {
                    begin: [
                        /\b(?:block|class|connector|function|model|operator|package|record|type)\b/,
                        /\s+/,
                        /(?!(?:record|function)\b)(?:[A-Za-z_]\w*|'[^'\n]*')/
                    ],
                    beginScope: { 1: 'keyword', 3: 'title.class' }
                },
                // `end Foo;` — but not `end if` / `end for` / `end when` / `end while`.
                {
                    begin: [
                        /\bend\b/,
                        /\s+/,
                        /(?!(?:if|for|when|while)\b)(?:[A-Za-z_]\w*|'[^'\n]*')/
                    ],
                    beginScope: { 1: 'keyword', 3: 'title.class' }
                },
                NUMBER
            ]
        };
    }

    if (typeof hljs !== 'undefined' && typeof hljs.registerLanguage === 'function') {
        try {
            hljs.registerLanguage('modelica', modelica);
        } catch (e) {
            console.warn('failed to register the modelica hljs language', e);
        }
    }
})();
