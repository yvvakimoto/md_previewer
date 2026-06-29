// Re-export the markwhen parser surface used by the previewer's custom
// timeline renderer (renderMarkwhenCached in assets/index.html).
// The parser resolves natural-language dates into ISO strings, so the
// renderer needs no runtime date library.
export * from '@markwhen/parser';
