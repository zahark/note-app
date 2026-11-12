import type { ComponentType } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import {
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImagePlusIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  PaperclipIcon,
  QuoteIcon,
  Redo2Icon,
  SquareCodeIcon,
  StrikethroughIcon,
  Undo2Icon,
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'

interface ToolbarProps {
  editor: Editor
  /** Opens the image file picker. */
  onInsertImage: () => void
  /** Opens the PDF/GPX file picker. */
  onAttachFile: () => void
  /** An upload is in progress. */
  uploading?: boolean
}

interface ToolbarButtonProps {
  label: string
  icon: ComponentType
  onClick: () => void
  active?: boolean
  disabled?: boolean
}

function ToolbarButton({ label, icon: Icon, onClick, active, disabled }: ToolbarButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      className={cn(active && 'bg-accent text-accent-foreground')}
      // keep the editor's selection: a toolbar click must not blur it first
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon />
    </Button>
  )
}

const Separator = () => <div aria-hidden className="mx-1 h-5 w-px bg-border" />

/** Asks for a link target; an empty answer removes the link. */
function editLink(editor: Editor) {
  const previous = (editor.getAttributes('link').href as string | undefined) ?? ''
  const href = window.prompt('Link URL', previous)
  if (href === null) return
  const chain = editor.chain().focus().extendMarkRange('link')
  if (href.trim() === '') chain.unsetLink().run()
  else chain.setLink({ href: href.trim() }).run()
}

/** Formatting toolbar for the note editor. */
export function Toolbar({ editor, onInsertImage, onAttachFile, uploading }: ToolbarProps) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      taskList: e.isActive('taskList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })
  const run = () => editor.chain().focus()

  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1">
      <ToolbarButton label="Undo" icon={Undo2Icon} disabled={!state.canUndo} onClick={() => run().undo().run()} />
      <ToolbarButton label="Redo" icon={Redo2Icon} disabled={!state.canRedo} onClick={() => run().redo().run()} />
      <Separator />
      <ToolbarButton label="Bold" icon={BoldIcon} active={state.bold} onClick={() => run().toggleBold().run()} />
      <ToolbarButton label="Italic" icon={ItalicIcon} active={state.italic} onClick={() => run().toggleItalic().run()} />
      <ToolbarButton
        label="Strikethrough"
        icon={StrikethroughIcon}
        active={state.strike}
        onClick={() => run().toggleStrike().run()}
      />
      <ToolbarButton label="Inline code" icon={CodeIcon} active={state.code} onClick={() => run().toggleCode().run()} />
      <ToolbarButton label="Link" icon={LinkIcon} active={state.link} onClick={() => editLink(editor)} />
      <Separator />
      <ToolbarButton
        label="Heading 1"
        icon={Heading1Icon}
        active={state.h1}
        onClick={() => run().toggleHeading({ level: 1 }).run()}
      />
      <ToolbarButton
        label="Heading 2"
        icon={Heading2Icon}
        active={state.h2}
        onClick={() => run().toggleHeading({ level: 2 }).run()}
      />
      <ToolbarButton
        label="Heading 3"
        icon={Heading3Icon}
        active={state.h3}
        onClick={() => run().toggleHeading({ level: 3 }).run()}
      />
      <Separator />
      <ToolbarButton
        label="Bullet list"
        icon={ListIcon}
        active={state.bulletList}
        onClick={() => run().toggleBulletList().run()}
      />
      <ToolbarButton
        label="Numbered list"
        icon={ListOrderedIcon}
        active={state.orderedList}
        onClick={() => run().toggleOrderedList().run()}
      />
      <ToolbarButton
        label="Task list"
        icon={ListTodoIcon}
        active={state.taskList}
        onClick={() => run().toggleTaskList().run()}
      />
      <ToolbarButton
        label="Quote"
        icon={QuoteIcon}
        active={state.blockquote}
        onClick={() => run().toggleBlockquote().run()}
      />
      <ToolbarButton
        label="Code block"
        icon={SquareCodeIcon}
        active={state.codeBlock}
        onClick={() => run().toggleCodeBlock().run()}
      />
      <Separator />
      <ToolbarButton label="Insert image" icon={ImagePlusIcon} disabled={uploading} onClick={onInsertImage} />
      <ToolbarButton label="Attach file" icon={PaperclipIcon} disabled={uploading} onClick={onAttachFile} />
    </div>
  )
}
