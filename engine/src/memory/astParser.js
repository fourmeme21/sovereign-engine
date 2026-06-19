import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
export class ASTParser {
    tsParser;
    jsParser;
    constructor() {
        this.tsParser = new Parser();
        this.tsParser.setLanguage(TypeScript.typescript);
        this.jsParser = new Parser();
        this.jsParser.setLanguage(JavaScript);
    }
    parse(code, filePath) {
        const isTS = filePath.endsWith(".ts") || filePath.endsWith(".tsx");
        const parser = isTS ? this.tsParser : this.jsParser;
        const tree = parser.parse(code);
        const chunks = [];
        const imports = this.extractImports(tree.rootNode);
        this.traverseNode(tree.rootNode, code, filePath, chunks, imports);
        return chunks;
    }
    traverseNode(node, code, filePath, chunks, imports, enclosingClass) {
        const ENTITY_TYPES = [
            "function_declaration", "method_definition", "class_declaration",
            "interface_declaration", "type_alias_declaration", "lexical_declaration",
        ];
        if (ENTITY_TYPES.includes(node.type)) {
            const name = this.extractName(node);
            if (!name)
                return;
            const body = code.slice(node.startIndex, node.endIndex);
            const lines = code.slice(0, node.startIndex).split("\n");
            const startLine = lines.length;
            chunks.push({
                type: this.mapNodeType(node.type),
                name, body, startLine,
                endLine: startLine + body.split("\n").length,
                hasToDoFixMe: /TODO|FIXME/i.test(body),
                imports, enclosingClass, filePath,
                fileModule: filePath.replace(/^.*\/src\//, "").replace(/\.[jt]sx?$/, ""),
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
    extractImports(root) {
        return root.children
            .filter((n) => n.type === "import_statement")
            .map((n) => n.text);
    }
    extractName(node) {
        for (const child of node.children) {
            if (child.type === "identifier" || child.type === "property_identifier")
                return child.text;
        }
        return null;
    }
    mapNodeType(nodeType) {
        const map = {
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
//# sourceMappingURL=astParser.js.map