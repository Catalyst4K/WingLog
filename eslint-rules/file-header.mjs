/**
 * WingLog's local ESLint rule for the coding standards' file header (flightdeck-backend
 * docs/coding-standards.md §2): every source file opens with a `/** … *\/` comment saying what it
 * is for, before any import or code.
 */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require a /** … */ header comment at the top of every source file' },
    messages: { missing: 'Open the file with a /** … */ header saying what it is for (coding-standards.md §2).' },
    schema: []
  },
  create(context) {
    return {
      Program(program) {
        const { sourceCode } = context
        const first = sourceCode.getAllComments()[0]
        const firstToken = sourceCode.ast.tokens[0]
        const isHeader =
          first !== undefined &&
          first.type === 'Block' &&
          first.value.startsWith('*') &&
          (firstToken === undefined || first.range[0] < firstToken.range[0])
        if (!isHeader) context.report({ node: program, loc: { line: 1, column: 0 }, messageId: 'missing' })
      }
    }
  }
}
