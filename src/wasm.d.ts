// Type declaration for .wasm files imported via esbuild --loader:.wasm=base64
// esbuild inlines the file as a base64 string; decode with Buffer.from(x, 'base64')
declare module '*.wasm' {
  const content: string;
  export default content;
}
