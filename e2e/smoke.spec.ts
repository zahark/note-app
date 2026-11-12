import { expect, test, type Locator, type Page } from '@playwright/test'
import { solidPng } from './png'

/**
 * Smoke path through the production build: sign up, organize, write with images, share by PIN and
 * read the share in a fresh browser, then check that images survive reloads, renames and the
 * deletion of the note they were first pasted into.
 */

const PASSWORD = 'correct horse battery staple'

// one owner per run (the server starts on an empty DATA_DIR), so the first signup becomes the owner
const email = `owner-${Date.now()}@example.com`

const IMAGE_A = { name: 'red.png', mimeType: 'image/png', buffer: solidPng(8, 6, [220, 40, 40]) }
const IMAGE_C = { name: 'blue.png', mimeType: 'image/png', buffer: solidPng(12, 9, [40, 60, 220]) }

const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' })
const treeItem = (scope: Page | Locator, name: string) => scope.getByRole('treeitem', { name, exact: true })
/** The clickable / draggable row of a tree item (its "…" button is named "Actions for <name>"). */
const rowButton = (page: Page, name: string) => tree(page).getByRole('button', { name, exact: true })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Note title' })
const noteContent = (page: Page) => page.getByLabel('Note content')
const saveStatus = (page: Page) => page.getByRole('status', { name: 'Save status' })

const isPath = (pattern: RegExp, method: string) => (response: { url(): string; request(): { method(): string } }) =>
  pattern.test(new URL(response.url()).pathname) && response.request().method() === method

/** Runs `action`, waits for the content save it triggers (`PUT …/content`), then for "Saved". */
async function expectSaved(page: Page, action: () => Promise<void>) {
  const save = page.waitForResponse(isPath(/^\/api\/notes\/[^/]+\/content$/, 'PUT'))
  await action()
  expect((await save).status()).toBe(200)
  await expect(saveStatus(page)).toHaveText('Saved')
}

/** Uploads an image through the toolbar's file input and waits until the note referencing it is saved. */
async function insertImage(page: Page, file: typeof IMAGE_A) {
  const upload = page.waitForResponse(isPath(/^\/api\/attachments$/, 'POST'))
  await expectSaved(page, async () => {
    await page.getByTestId('image-file-input').setInputFiles(file)
    expect((await upload).status()).toBe(201)
  })
}

/** Creates a note at the root, names it, and leaves the cursor in its content. Returns its id. */
async function createRootNote(page: Page, title: string): Promise<string> {
  const create = page.waitForResponse(isPath(/^\/api\/notes$/, 'POST'))
  await page.getByRole('button', { name: 'New note at root' }).click()
  expect((await create).status()).toBe(201)
  await expect(titleField(page)).toBeVisible()
  const rename = page.waitForResponse(isPath(/^\/api\/notes\/[^/]+$/, 'PATCH'))
  await titleField(page).fill(title)
  // Enter saves the title and moves the cursor into the content
  await titleField(page).press('Enter')
  expect((await rename).status()).toBe(200)
  await expect(treeItem(tree(page), title)).toBeVisible()
  const id = new URL(page.url()).searchParams.get('note')
  expect(id).toBeTruthy()
  return id!
}

/** Drags with the mouse past dnd-kit's 5 px activation distance, then onto the target. */
async function dragTo(page: Page, source: Locator, target: Locator) {
  const from = (await source.boundingBox())!
  const to = (await target.boundingBox())!
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
}

/** An `<img>` that is visible and actually decoded (`naturalWidth` is the PNG's width). */
async function expectImageLoaded(img: Locator, width: number) {
  await expect(img).toBeVisible()
  await expect(img).toHaveJSProperty('naturalWidth', width)
}

test('notes smoke path: organize, write, upload, share by PIN, copy images across notes', async ({ page, browser }) => {
  test.setTimeout(120_000)
  let noteAId = ''
  let pinLink = ''
  let pin = ''

  await test.step('sign up', async () => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
    await page.getByRole('button', { name: 'Create one' }).click()
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to Notes' })).toBeVisible()
  })

  await test.step('create a folder and note A', async () => {
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    // a new folder opens in rename mode
    const renameFolder = page.getByRole('textbox', { name: 'Rename folder' })
    await renameFolder.fill('Projects')
    await renameFolder.press('Enter')
    await expect(rowButton(page, 'Projects')).toBeVisible()

    noteAId = await createRootNote(page, 'Note A')
    await expectSaved(page, () => page.keyboard.type('Hello from note A.'))
  })

  await test.step('drag note A into the folder', async () => {
    const move = page.waitForResponse(isPath(/^\/api\/notes\/[^/]+\/move$/, 'PATCH'))
    await dragTo(page, rowButton(page, 'Note A'), rowButton(page, 'Projects'))
    expect((await move).status()).toBe(200)
    // the target folder is expanded after the move, showing A inside it
    await expect(treeItem(treeItem(tree(page), 'Projects'), 'Note A')).toBeVisible()
    await expect(tree(page).getByRole('treeitem', { name: 'Note A', exact: true })).toHaveAttribute('aria-level', '2')
  })

  await test.step('upload an image into note A', async () => {
    await insertImage(page, IMAGE_A)
    const img = noteContent(page).locator('img[data-attachment-id]')
    await expectImageLoaded(img, 8)
    // the owner editor resolves attachment://<aid> to the owner route inside the node view only
    await expect(img).toHaveAttribute('src', /^\/api\/attachments\/[0-9a-f-]+$/)
  })

  await test.step('share note A by PIN', async () => {
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Create PIN' }).click()
    pin = await dialog.getByRole('textbox', { name: 'Shared pin' }).inputValue()
    pinLink = await dialog.getByRole('textbox', { name: 'Shared link' }).inputValue()
    expect(pin).toMatch(/^\S{8}$/)
    expect(pinLink).toBe(new URL(`/shared/${noteAId}`, page.url()).toString())
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('button', { name: 'Shared', exact: true })).toBeVisible()
  })

  await test.step('open the PIN link in a fresh browser context and unlock', async () => {
    const visitor = await browser.newContext()
    try {
      const shared = await visitor.newPage()
      await shared.goto(pinLink)
      await expect(shared.getByRole('heading', { name: 'This note is protected' })).toBeVisible()
      await shared.getByLabel('PIN').fill(pin)
      await shared.getByRole('button', { name: 'Unlock' }).click()

      await expect(shared.getByRole('heading', { name: 'Note A' })).toBeVisible()
      await expect(shared.getByText('Shared note · read-only')).toBeVisible()
      const content = shared.getByLabel('Shared note content')
      await expect(content).toContainText('Hello from note A.')
      // read-only, and none of the owner app: no sidebar tree, toolbar or title field
      await expect(content).toHaveAttribute('contenteditable', 'false')
      await expect(shared.getByRole('tree')).toHaveCount(0)
      await expect(shared.getByRole('toolbar')).toHaveCount(0)
      await expect(shared.getByRole('textbox', { name: 'Note title' })).toHaveCount(0)
      // the image is fetched with the token in a header and shown as a blob URL
      const img = content.locator('img[data-attachment-id]')
      await expectImageLoaded(img, 8)
      await expect(img).toHaveAttribute('src', /^blob:/)
      // the token stays in memory, never in the URL
      expect(shared.url()).toBe(pinLink)
    } finally {
      await visitor.close()
    }
  })

  await test.step('reload A, add text, and keep the image across reloads', async () => {
    await page.reload()
    const img = noteContent(page).locator('img[data-attachment-id]')
    await expectImageLoaded(img, 8)

    await noteContent(page).getByText('Hello from note A.').click()
    await page.keyboard.press('End')
    await expectSaved(page, () => page.keyboard.type(' More text after reload.'))

    await page.reload()
    await expect(noteContent(page)).toContainText('Hello from note A. More text after reload.')
    await expectImageLoaded(noteContent(page).locator('img[data-attachment-id]'), 8)
  })

  await test.step('rename A in the sidebar while it is open, then type: the new title survives', async () => {
    await rowButton(page, 'Note A').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const renameNote = page.getByRole('textbox', { name: 'Rename note' })
    await expect(renameNote).toBeFocused()
    const rename = page.waitForResponse(isPath(/^\/api\/notes\/[^/]+$/, 'PATCH'))
    await renameNote.fill('Note A renamed')
    await renameNote.press('Enter')
    expect((await rename).status()).toBe(200)
    await expect(titleField(page)).toHaveValue('Note A renamed')

    await noteContent(page).getByText('More text after reload.').click()
    await page.keyboard.press('End')
    await expectSaved(page, () => page.keyboard.type(' Typed after the rename.'))

    await page.reload()
    await expect(titleField(page)).toHaveValue('Note A renamed')
    await expect(rowButton(page, 'Note A renamed')).toBeVisible()
    await expect(noteContent(page)).toContainText('Typed after the rename.')
    await expectImageLoaded(noteContent(page).locator('img[data-attachment-id]'), 8)
  })

  let imageCId = ''
  let noteDId = ''

  await test.step('create note C with an image and copy the image into a new note D', async () => {
    await createRootNote(page, 'Note C')
    await expectSaved(page, () => page.keyboard.type('Source of the copied image.'))
    await insertImage(page, IMAGE_C)
    const imgC = noteContent(page).locator('img[data-attachment-id]')
    await expectImageLoaded(imgC, 12)
    imageCId = (await imgC.getAttribute('data-attachment-id'))!

    // copy the whole content of C (text and image) through the real clipboard
    await noteContent(page).getByText('Source of the copied image.').click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('ControlOrMeta+C')

    noteDId = await createRootNote(page, 'Note D')
    await expectSaved(page, () => page.keyboard.press('ControlOrMeta+V'))
    const imgD = noteContent(page).locator('img[data-attachment-id]')
    await expectImageLoaded(imgD, 12)
    // the pasted image is the same attachment, still stored as a reference
    await expect(imgD).toHaveAttribute('data-attachment-id', imageCId)
    const saved = await page.request.get(`/api/notes/${noteDId}`)
    expect(JSON.stringify((await saved.json()).note.content)).toContain(`attachment://${imageCId}`)
  })

  await test.step('delete note C: the image still loads in D', async () => {
    await rowButton(page, 'Note C').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const remove = page.waitForResponse(isPath(/^\/api\/notes\/[^/]+$/, 'DELETE'))
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    expect((await remove).status()).toBe(204)
    await expect(treeItem(tree(page), 'Note C')).toHaveCount(0)

    await rowButton(page, 'Note D').click()
    await expect(titleField(page)).toHaveValue('Note D')
    await page.reload()
    await expectImageLoaded(noteContent(page).locator(`img[data-attachment-id="${imageCId}"]`), 12)

    // D's own reference keeps the image: its share serves the image, which only happens when D links it
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Create link' }).click()
    const link = await dialog.getByRole('textbox', { name: 'Shared link' }).inputValue()
    await dialog.getByRole('button', { name: 'Done' }).click()

    const visitor = await browser.newContext()
    try {
      const shared = await visitor.newPage()
      await shared.goto(link)
      await expect(shared.getByRole('heading', { name: 'Note D' })).toBeVisible()
      await expectImageLoaded(shared.getByLabel('Shared note content').locator('img[data-attachment-id]'), 12)
    } finally {
      await visitor.close()
    }
  })
})
