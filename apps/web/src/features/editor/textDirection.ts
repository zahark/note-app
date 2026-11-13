import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/** Blocks that keep the page's left-to-right direction whatever they contain. */
const FIXED_DIRECTION = new Set(['codeBlock'])

/** A `dir="auto"` node decoration on every text-holding block (paragraph, heading, list, list item, quote). */
function directionDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (FIXED_DIRECTION.has(node.type.name)) return false
    if (!node.isBlock || node.isAtom) return false
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir: 'auto' }))
    return !node.isTextblock
  })
  return DecorationSet.create(doc, decorations)
}

/**
 * Right-to-left text (Hebrew, Arabic): each block takes its direction from its first strong letter,
 * so a paragraph that starts in Hebrew runs and aligns from the right, and an English one from the
 * left. Done with `dir="auto"` decorations on screen only: nothing is added to the stored note.
 */
export const AutoTextDirection = Extension.create({
  name: 'autoTextDirection',

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
