import { Extension, type Editor } from '@tiptap/core'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export type TextDirection = 'ltr' | 'rtl'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    autoTextDirection: {
      /** Forces the direction of the paragraph(s) or list item(s) at the selection; null goes back to automatic. */
      setTextDirection: (direction: TextDirection | null) => ReturnType
    }
  }
}

/** Blocks that keep the page's left-to-right direction whatever they contain. */
const FIXED_DIRECTION = new Set(['codeBlock'])
/** Text blocks whose direction can be forced (outside a list). */
const DIRECTED_TEXTBLOCKS = new Set(['paragraph', 'heading'])
/** List items, whose forced direction covers the whole item (marker side included). */
const DIRECTED_ITEMS = new Set(['listItem', 'taskItem'])

const parseDirection = (value: unknown): TextDirection | null => (value === 'ltr' || value === 'rtl' ? value : null)

/**
 * `dir="auto"` node decorations on every text-holding block (paragraph, heading, list, list item,
 * quote) whose direction is not forced, so each takes its direction from its first strong letter.
 */
function directionDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (FIXED_DIRECTION.has(node.type.name)) return false
    if (!node.isBlock || node.isAtom) return false
    if (parseDirection(node.attrs.dir) === null) decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir: 'auto' }))
    return !node.isTextblock
  })
  return DecorationSet.create(doc, decorations)
}

/** The block a direction applies to at `$pos`: the innermost list item, else the paragraph/heading. */
function directionTarget($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (DIRECTED_ITEMS.has($pos.node(depth).type.name)) return $pos.before(depth)
  }
  const parent = $pos.parent
  return parent.isTextblock && DIRECTED_TEXTBLOCKS.has(parent.type.name) && $pos.depth > 0 ? $pos.before() : null
}

/** Positions of every block the selection's direction applies to, in document order. */
function directionTargets(state: EditorState): number[] {
  const { from, to, $from } = state.selection
  const targets = new Set<number>()
  const first = directionTarget($from)
  if (first !== null) targets.add(first)
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true
    const target = directionTarget(state.doc.resolve(pos + 1))
    if (target !== null) targets.add(target)
    return false
  })
  return [...targets].sort((a, b) => a - b)
}

/** The forced direction of the block at the cursor, or null when it is automatic. */
export function forcedTextDirection(editor: Editor): TextDirection | null {
  const [target] = directionTargets(editor.state)
  return target === undefined ? null : parseDirection(editor.state.doc.nodeAt(target)?.attrs.dir)
}

/** The toolbar's direction buttons: a second press on the active direction goes back to automatic. */
export function toggleTextDirection(editor: Editor, direction: TextDirection): void {
  const next = forcedTextDirection(editor) === direction ? null : direction
  editor.chain().focus().setTextDirection(next).run()
}

/**
 * Right-to-left text (Hebrew, Arabic). By default each block takes its direction from its first
 * strong letter, so a paragraph that starts in Hebrew runs and aligns from the right and an English
 * one from the left; that is done with `dir="auto"` decorations on screen only, nothing stored. When
 * the first letter guesses wrong (a Hebrew sentence that starts with an English word), the toolbar's
 * direction buttons force `dir="rtl"` / `dir="ltr"` on the paragraph, heading or list item, and that
 * is stored as the node's `dir` attribute.
 */
export const AutoTextDirection = Extension.create({
  name: 'autoTextDirection',

  addGlobalAttributes() {
    return [
      {
        types: [...DIRECTED_TEXTBLOCKS, ...DIRECTED_ITEMS],
        attributes: {
          dir: {
            default: null,
            keepOnSplit: true,
            parseHTML: (element) => parseDirection(element.getAttribute('dir')),
            renderHTML: (attributes) => {
              const dir = parseDirection(attributes.dir)
              return dir ? { dir } : {}
            },
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setTextDirection:
        (direction) =>
        ({ state, tr, dispatch }) => {
          const targets = directionTargets(state)
          if (targets.length === 0) return false
          if (dispatch) for (const pos of targets) tr.setNodeAttribute(pos, 'dir', direction)
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: new PluginKey('autoTextDirection'),
        state: {
          init: (_, state) => directionDecorations(state.doc),
          apply: (tr, decorations) => (tr.docChanged ? directionDecorations(tr.doc) : decorations),
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
        },
      }),
    ]
  },
})
