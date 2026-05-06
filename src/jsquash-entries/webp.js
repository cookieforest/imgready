/* WebP encode-only entry for the imgready bundle. We never decode WebP
   in our pipeline (the browser handles that natively via createImageBitmap),
   so importing only `encode` keeps the bundle tighter — esbuild tree-shakes
   the decoder away. */
export { encode } from '@jsquash/webp';
