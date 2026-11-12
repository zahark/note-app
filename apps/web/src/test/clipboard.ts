import type { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'

/** A minimal DataTransfer stand-in: ProseMirror only uses get/set/clearData on copy and paste. */
export function fakeClipboard() {
  const data = new Map<string, string>()
  return {
    data,
    clipboardData: {
      getData: (type: string) => data.get(type) ?? '',
      setData: (type: string, value: string) => void data.set(type, value),
      clearData: () => data.clear(),
      files: [] as File[],
      items: [] as DataTransferItem[],
      types: [] as string[],
    },
  }
}

export function clipboardEvent(type: 'copy' | 'cut' | 'paste', clipboardData: unknown): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  return event
}

/** Position of the first node of type `typeName` (fails the lookup with -1). */
export function firstNodePos(editor: Editor, typeName: string): number {
  let pos = -1
  editor.state.doc.descendants((node, p) => {
    if (pos < 0 && node.type.name === typeName) pos = p
  })
  return pos
}

/** Selects the node at `pos` and copies (or cuts) it the way the browser does: an event on the editor. */
export function copyNodeAt(editor: Editor, pos: number, type: 'copy' | 'cut' = 'copy'): Map<string, string> {
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
  const { data, clipboardData } = fakeClipboard()
  editor.view.dom.dispatchEvent(clipboardEvent(type, clipboardData))
  return data
}

/** Puts the cursor at the end of the document and pastes the clipboard contents. */
export function pasteAtEnd(editor: Editor, data: Map<string, string>) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)))
  const { data: target, clipboardData } = fakeClipboard()
  for (const [type, value] of data) target.set(type, value)
  editor.view.dom.dispatchEvent(clipboardEvent('paste', clipboardData))
}
