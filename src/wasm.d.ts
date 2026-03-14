// Type declaration for .wasm files imported via esbuild --loader:.wasm=binary
// esbuild inlines the binary as a Buffer (Uint8Array subclass) in CJS output
declare module '*.wasm' {
  const content: Buffer;
  export default content;
}
