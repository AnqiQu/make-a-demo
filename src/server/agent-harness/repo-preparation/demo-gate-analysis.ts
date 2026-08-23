import ts from "typescript";

/**
 * The one token the pipeline itself owns and instructs preparation agents to
 * use. Substring, not delimiter-bound: framework conventions prefix it
 * (`VITE_`, `NEXT_PUBLIC_`) and define-constants wrap it in underscores
 * (`__MAKEADEMO_DEMO__`), and every such spelling is still the pipeline's
 * gate (excalidraw, 2026-08-09).
 */
const gateNamePattern = /makeademo_demo/i;

export type DemoGateAnalysis = {
  /** Identifiers this source imports or declares, by any declaration form. */
  boundNames: readonly string[];
  /**
   * Identifiers this source binds to the gate: const/let/var whose
   * initializer, or function whose body, references a gate name or another
   * gate binding — followed transitively through local bindings. Caller-
   * supplied `knownGateIdentifiers` seed the transitive walk but are not
   * echoed back here.
   */
  gateBindings: readonly string[];
  /** Raw gate-flavored names referenced: identifiers, env/define properties. */
  gateNames: readonly string[];
  /**
   * True when a gate name or gate binding is referenced inside an
   * if-condition, a ternary condition, or a `&&`/`||` operand — the shapes a
   * demo gate takes, including guard-clause early returns.
   */
  hasConditionalGate: boolean;
};

/**
 * Parses one JavaScript-family source (js/jsx/ts/tsx/mjs/cjs/mts/cts, plus
 * the `<script>` blocks of .vue/.svelte components) and reports how it uses
 * the MakeADemo demo gate. Implementations of fidelity checking rely on the
 * fail-open contract: a non-JS-family file, a component without a script
 * block, or a parser failure returns `undefined`, and "no gate found"
 * without a parse must never justify a veto. Comments never count — the
 * parser sees them as trivia — and bare string literals count only in
 * env-lookup or property-key positions, never as free-floating text.
 */
export function analyzeDemoGateUsage(input: {
  fileName: string;
  knownGateIdentifiers?: readonly string[];
  source: string;
}): DemoGateAnalysis | undefined {
  const script = readScriptSource(input.fileName, input.source);
  if (script === undefined) {
    return undefined;
  }
  try {
    const sourceFile = ts.createSourceFile(
      "demo-gate-analysis.tsx",
      script.text,
      ts.ScriptTarget.Latest,
      true,
      script.kind,
    );
    return analyzeSourceFile(sourceFile, input.knownGateIdentifiers ?? []);
  } catch {
    return undefined;
  }
}

function readScriptSource(
  fileName: string,
  source: string,
): { kind: ts.ScriptKind; text: string } | undefined {
  const lower = fileName.toLowerCase();
  if (/\.(?:vue|svelte)$/.test(lower)) {
    const blocks = [
      ...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
    ].map((match) => match[1] ?? "");
    if (blocks.length === 0) {
      return undefined;
    }
    return { kind: ts.ScriptKind.TS, text: blocks.join("\n") };
  }
  if (/\.tsx$/.test(lower)) {
    return { kind: ts.ScriptKind.TSX, text: source };
  }
  if (/\.(?:ts|mts|cts)$/.test(lower)) {
    return { kind: ts.ScriptKind.TS, text: source };
  }
  if (/\.(?:js|jsx|mjs|cjs)$/.test(lower)) {
    // JSX kind so plain .js files carrying JSX still parse cleanly.
    return { kind: ts.ScriptKind.JSX, text: source };
  }
  return undefined;
}

function analyzeSourceFile(
  sourceFile: ts.SourceFile,
  knownGateIdentifiers: readonly string[],
): DemoGateAnalysis {
  const gateNames = new Set<string>();
  const boundNames = new Set<string>();
  const seeds = new Set(knownGateIdentifiers);
  const bindings = new Set(knownGateIdentifiers);

  const visitAll = (visit: (node: ts.Node) => void) => {
    const walk = (node: ts.Node) => {
      visit(node);
      ts.forEachChild(node, walk);
    };
    walk(sourceFile);
  };

  visitAll((node) => {
    if (ts.isIdentifier(node) && gateNamePattern.test(node.text)) {
      gateNames.add(node.text);
    }
    if (isGateStringKey(node)) {
      gateNames.add(node.text);
    }
    const declaredName = readDeclaredName(node);
    if (declaredName !== undefined) {
      boundNames.add(declaredName);
    }
  });

  // Transitive gate bindings: each pass may unlock the next hop, and the
  // pass count is bounded by the source's own declaration chain depth.
  for (let pass = 0; pass < 10; pass += 1) {
    let changed = false;
    visitAll((node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        !bindings.has(node.name.text) &&
        referencesGate(node.initializer, bindings)
      ) {
        bindings.add(node.name.text);
        changed = true;
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.body !== undefined &&
        !bindings.has(node.name.text) &&
        referencesGate(node.body, bindings)
      ) {
        bindings.add(node.name.text);
        changed = true;
      }
    });
    if (!changed) {
      break;
    }
  }

  let hasConditionalGate = false;
  visitAll((node) => {
    if (hasConditionalGate) {
      return;
    }
    if (isGateReference(node, bindings) && isInConditionalPosition(node)) {
      hasConditionalGate = true;
    }
  });

  return {
    boundNames: [...boundNames],
    gateBindings: [...bindings].filter((name) => !seeds.has(name)),
    gateNames: [...gateNames],
    hasConditionalGate,
  };
}

/** A string literal names the gate only in env-lookup or key positions. */
function isGateStringKey(node: ts.Node): node is ts.StringLiteralLike {
  if (!ts.isStringLiteralLike(node) || !gateNamePattern.test(node.text)) {
    return false;
  }
  const parent = node.parent;
  return (
    (ts.isElementAccessExpression(parent) &&
      parent.argumentExpression === node) ||
    ts.isComputedPropertyName(parent) ||
    (ts.isPropertyAssignment(parent) && parent.name === node)
  );
}

function readDeclaredName(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.name !== undefined
  ) {
    return node.name.text;
  }
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (
    (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (ts.isImportClause(node) && node.name !== undefined) {
    return node.name.text;
  }
  return undefined;
}

function referencesGate(root: ts.Node, bindings: ReadonlySet<string>): boolean {
  let found = false;
  const walk = (node: ts.Node) => {
    if (found) {
      return;
    }
    if (isGateReference(node, bindings)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(root);
  return found;
}

function isGateReference(
  node: ts.Node,
  bindings: ReadonlySet<string>,
): boolean {
  if (isGateStringKey(node)) {
    return true;
  }
  if (!ts.isIdentifier(node)) {
    return false;
  }
  if (gateNamePattern.test(node.text)) {
    return true;
  }
  return bindings.has(node.text) && isBindingReferencePosition(node);
}

/**
 * A binding identifier counts as a use only outside declaration-name and
 * foreign-property positions: `other.isDemo` reads someone else's property,
 * and `const isDemo = …` names the binding rather than reading it.
 */
function isBindingReferencePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return false;
  }
  if (
    (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportClause(parent)
  ) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }
  if (ts.isParameter(parent) && parent.name === node) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.name === node) {
    return false;
  }
  return true;
}

/**
 * Climbs the ancestor chain checking whether the reference sits inside an
 * if-condition, a ternary condition, or a logical `&&`/`||` expression —
 * comparison wrappers such as `=== "true"` and negations climb through.
 */
function isInConditionalPosition(node: ts.Node): boolean {
  let child: ts.Node = node;
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor !== undefined) {
    if (ts.isIfStatement(ancestor) && ancestor.expression === child) {
      return true;
    }
    if (ts.isConditionalExpression(ancestor) && ancestor.condition === child) {
      return true;
    }
    if (
      ts.isBinaryExpression(ancestor) &&
      (ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        ancestor.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return true;
    }
    child = ancestor;
    ancestor = ancestor.parent;
  }
  return false;
}
