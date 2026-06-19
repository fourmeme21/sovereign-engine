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
export declare class ASTParser {
    private tsParser;
    private jsParser;
    constructor();
    parse(code: string, filePath: string): ASTChunk[];
    private traverseNode;
    private extractImports;
    private extractName;
    private mapNodeType;
}
//# sourceMappingURL=astParser.d.ts.map