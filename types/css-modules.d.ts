// Allow importing CSS files from node_modules.
declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}
