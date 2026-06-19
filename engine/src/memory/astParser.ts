import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";

export interface ASTChunk {
  type: "function" | "class" | "interface" | "type" | "constant";
  name: string;
  body: string;
  startLine: number;
  endLine: number;
  hasToDoFixMe: boolean;
  imports: string[];
  enclosingClass?: string;
  filePath: string;
  fileModule: string;
}

export class ASTParser {
  private tsParser: Parser;
  private jsParser: Parser;

  constructor() {
    this.tsParser = new Parser();
    this.tsParser.setLanguage(TypeScript.typescript);
    this.jsParser = new Parser();
    this.jsParser.setLanguage(JavaScript);
  }

  parse(code: string, filePath: string): ASTChunk[] {
    const isTS = filePath.endsWith(".ts") || filePath.endsWith(".tsx");
    const parser = isTS ? this.tsParser : this.jsParser;
    const tree = parser.parse(code);
    const chunks: ASTChunk[] = [];
    const imports = this.extractImports(tree.rootNode);
    this.traverseNode(tree.rootNode, code, filePath, chunks, imports);
    return chunks;
  }

  private traverseNode(
    node: any, code: string, filePath: string,
    chunks: ASTChunk[], imports: string[], enclosingClass?: string
  ) {
    const ENTITY_TYPES = [
      "function_declaration", "method_definition", "class_declaration",
      "interface_declaration", "type_alias_declaration", "lexical_declaration",
    ];

    if (ENTITY_TYPES.includes(node.type)) {
      const name = this.extractName(node);
      if (!name) return;
      const body = code.slice(node.startIndex, node.endIndex);
      const lines = code.slice(0, node.startIndex).split("\n");
      const startLine = lines.length;
      chunks.push({
        type: this.mapNodeType(node.type),
        name, body, startLine,
        endLine: startLine + body.split("\n").length,
        hasToDoFixMe: /TODO|FIXME/i.test(body),
        imports, filePath,
        fileModule: filePath.replace(/^.*\/src\//, "").replace(/\.[jt]sx?$/, ""),
        ...(enclosingClass !== undefined ? { enclosingClass } : {}),
      });
      if (node.type === "class_declaration") {
        for (const child of node.children) {
          if (child.type === "class_body") {
            this.traverseNode(child, code, filePath, chunks, imports, name);
          }
        }
        return;
      }
    }
    if (!ENTITY_TYPES.includes(node.type)) {
      for (const child of node.children) {
        this.traverseNode(child, code, filePath, chunks, imports, enclosingClass);
      }
    }
  }

  private extractImports(root: any): string[] {
    return root.children
      .filter((n: any) => n.type === "import_statement")
      .map((n: any) => n.text);
  }

  private extractName(node: any): string | null {
    for (const child of node.children) {
      if (child.type === "identifier" || child.type === "property_identifier")
        return child.text;
    }
    return null;
  }

  private mapNodeType(nodeType: string): ASTChunk["type"] {
    const map: Record<string, ASTChunk["type"]> = {
      function_declaration: "function",
      method_definition: "function",
      class_declaration: "class",
      interface_declaration: "interface",
      type_alias_declaration: "type",
      lexical_declaration: "constant",
    };
    return map[nodeType] || "function";
  }
}
