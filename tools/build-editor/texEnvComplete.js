// KaTeX/LaTeX environment-name completion for \begin{...}.
//
// Only fires when the cursor sits right after `\begin{` (with an optional
// partial environment name). Picking a completion inserts the env name plus a
// blank middle line and the matching \end{name}.

const TEX_ENVIRONMENTS = [
  'equation', 'equation*',
  'align', 'align*', 'aligned',
  'alignat', 'alignat*',
  'gather', 'gather*', 'gathered',
  'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix',
  'cases', 'dcases', 'rcases',
  'array', 'subarray',
  'split', 'multline', 'multline*',
  'CD',
  'darray', 'drcases',
];

// Envs that need a column / option argument right after the name — leave the
// cursor inside `{}` after the env name instead of jumping to the body line.
const NEEDS_ARG = new Set(['array', 'subarray', 'alignat', 'alignat*']);

function makeOption(name) {
  if (NEEDS_ARG.has(name)) {
    return {
      label: name,
      type: 'keyword',
      detail: 'env (needs arg)',
      apply: (view, _completion, from, to) => {
        const insert = `${name}}{}\n  \n\\end{${name}}`;
        // Position cursor inside the arg braces: after `${name}}{`
        const cursor = from + name.length + 2; // +"}{"
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: cursor },
        });
      },
    };
  }
  return {
    label: name,
    type: 'keyword',
    detail: 'env',
    apply: (view, _completion, from, to) => {
      const insert = `${name}}\n  \n\\end{${name}}`;
      // Cursor goes on the blank middle line, after the two-space indent.
      const cursor = from + name.length + 1 + 1 + 2; // +"}" +"\n" +"  "
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: cursor },
      });
    },
  };
}

const OPTIONS = TEX_ENVIRONMENTS.map(makeOption);

export function texEnvCompletionSource(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.doc.sliceString(line.from, context.pos);
  const m = /\\begin\{([A-Za-z*]*)$/.exec(before);
  if (!m) return null;
  const start = line.from + m.index + '\\begin{'.length;
  return {
    from: start,
    to: context.pos,
    options: OPTIONS,
    validFor: /^[A-Za-z*]*$/,
  };
}
