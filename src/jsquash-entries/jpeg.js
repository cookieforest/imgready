/* MozJPEG encoder entry. Used by the worker as a higher-quality
   alternative to canvas.toBlob('image/jpeg') — typically 10–25% smaller
   files at the same visible quality. */
export { encode } from '@jsquash/jpeg';
