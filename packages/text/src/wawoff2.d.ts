declare module "wawoff2" {
  export function decompress(src: Uint8Array): Promise<Uint8Array>;
  export function compress(src: Uint8Array): Promise<Uint8Array>;
  const wawoff: { decompress: typeof decompress; compress: typeof compress };
  export default wawoff;
}
