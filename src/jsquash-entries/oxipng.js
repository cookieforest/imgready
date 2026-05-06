/* OxiPNG entry — png post-processor. The library auto-detects
   single-thread vs multi-thread at runtime; in our setup the
   threads-feature-detect returns false (no SharedArrayBuffer because
   no COOP/COEP headers — AdSense conflicts with those), so it lazily
   uses the single-thread codec. Pass-through `optimise` re-export
   matches the call site name in the worker. */
export { optimise } from '@jsquash/oxipng';
