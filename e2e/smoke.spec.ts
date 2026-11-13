import { readFile } from 'node:fs/promises'
import { expect, test, type Download, type Locator, type Page } from '@playwright/test'
import { gpxTrack, solidPdf } from './files'
import { solidPng } from './png'

/**
 * Smoke path through the production build: sign up, organize, write with a link (popup, Open,
 * Cmd/Ctrl+click) and images, share by PIN and read the share (and open its link) in a fresh browser,
 * then check that images survive reloads, renames and the deletion of the note they were first
 * pasted into. A PDF (in-note viewer) and a GPX (download chip)
 * go along the same owner and shared paths, with no Content-Security-Policy violation on the way.
 */

const PASSWORD = 'correct horse battery staple'

// one owner per run (the server starts on an empty DATA_DIR), so the first signup becomes the owner
const email = `owner-${Date.now()}@example.com`

const IMAGE_A = { name: 'red.png', mimeType: 'image/png', buffer: solidPng(8, 6, [220, 40, 40]) }
const IMAGE_C = { name: 'blue.png', mimeType: 'image/png', buffer: solidPng(12, 9, [40, 60, 220]) }
// a red first page and a blue second one, so the canvas shows which page is drawn
const PDF = { name: 'route guide.pdf', mimeType: 'application/pdf', buffer: solidPdf([[1, 0, 0], [0, 0, 1]]) }
// browsers often report a GPX with no type at all: the client routes it by extension, the server by content
const GPX = {
  name: 'ridge loop.gpx',
  mimeType: '',
  buffer: gpxTrack('Ridge loop', [[46.5, 7.9], [46.51, 7.91], [46.52, 7.9]]),
}

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

/** Uploads a PDF or GPX through the toolbar's "Attach file" input and waits until the note is saved. */
async function attachFile(page: Page, file: typeof PDF) {
  const upload = page.waitForResponse(isPath(/^\/api\/attachments$/, 'POST'))
  await expectSaved(page, async () => {
    await page.getByTestId('attach-file-input').setInputFiles(file)
    expect((await upload).status()).toBe(201)
  })
}

/**
 * Collects Content-Security-Policy violations on `page` (and on pages opened later in its context):
 * `securitypolicyviolation` events reported by an init script, plus CSP console errors (which also
 * cover the PDF.js worker). Install it before the first navigation.
 */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = []
  await page.exposeBinding('__reportCspViolation', (_source, message: string) => violations.push(message))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __reportCspViolation: (message: string) => void }).__reportCspViolation
      void report(`${event.violatedDirective} blocked ${event.blockedURI || '(inline)'}`)
    })
  })
  page.on('console', (message) => {
    if (/Content[- ]Security[- ]Policy/i.test(message.text())) violations.push(message.text())
  })
  return violations
}

/** The RGB of the pixel at the center of a canvas. */
async function canvasCenterRgb(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d')!
    const pixel = context.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data
    return Array.from(pixel.subarray(0, 3))
  })
}

/** Checks the PDF viewer inside `scope`: page 1 of 2 drawn red, Next draws page 2 blue, then Previous back. */
async function expectPdfViewerWorks(scope: Locator) {
  const viewer = scope.locator('.attachment-file[data-kind="pdf"] .pdf-viewer')
  await expect(viewer).toHaveAttribute('data-state', 'ready')
  await expect(viewer.getByText('Page 1 of 2', { exact: true })).toBeVisible()
  const canvas = viewer.locator('canvas')
  await expect(canvas).toBeVisible()
  const size = (await canvas.boundingBox())!
  expect(size.width).toBeGreaterThan(0)
  expect(size.height).toBeGreaterThan(0)
  await expect.poll(() => canvasCenterRgb(canvas)).toEqual([255, 0, 0])

  const previous = viewer.getByRole('button', { name: 'Previous page' })
  const next = viewer.getByRole('button', { name: 'Next page' })
  await expect(previous).toBeDisabled()
  await next.click()
  await expect(viewer.getByText('Page 2 of 2', { exact: true })).toBeVisible()
  await expect(next).toBeDisabled()
  await expect.poll(() => canvasCenterRgb(canvas)).toEqual([0, 0, 255])
  await previous.click()
  await expect(viewer.getByText('Page 1 of 2', { exact: true })).toBeVisible()
  await expect.poll(() => canvasCenterRgb(canvas)).toEqual([255, 0, 0])
}

/** Clicks the GPX chip's Download button in `scope` and checks the saved file's name and bytes. */
async function expectGpxDownload(page: Page, scope: Locator) {
  const downloaded: Promise<Download> = page.waitForEvent('download')
  await scope.getByRole('button', { name: `Download ${GPX.name}` }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe(GPX.name)
  expect(await readFile((await download.path())!)).toEqual(GPX.buffer)
}

/** Runs `action` and checks that it opens `url` in a new tab of the page's context (then closes that tab). */
async function expectOpensTab(page: Page, url: string, action: () => Promise<void>) {
  const opened = page.context().waitForEvent('page')
  await action()
  const tab = await opened
  await tab.waitForLoadState()
  expect(tab.url()).toBe(url)
  await tab.close()
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

test('notes smoke path: organize, write, upload images and files, share by PIN, copy images across notes', async ({ page, browser }) => {
  test.setTimeout(120_000)
  let noteAId = ''
  let pinLink = ''
  let pin = ''
  const cspViolations = await watchCsp(page)
  // a link target on the test server itself, so opening it needs no outside network
  const linkUrl = new URL('/api/health', test.info().project.use.baseURL).toString()

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

  await test.step('link in note A: a click shows the link popup, Open and Cmd/Ctrl+click open a new tab', async () => {
    await page.keyboard.press('Enter')
    // typing a URL and a space makes it a link
    await expectSaved(page, () => page.keyboard.type(`Status: ${linkUrl} `))
    const link = noteContent(page).getByRole('link', { name: linkUrl })
    await expect(link).toHaveAttribute('href', linkUrl)

    await link.click()
    const popup = page.getByRole('group', { name: 'Link actions' })
    await expect(popup).toBeVisible()
    await expect(popup.getByText(linkUrl, { exact: true })).toBeVisible()
    await expect(noteContent(page)).toBeFocused()
    await expectOpensTab(page, linkUrl, () => popup.getByRole('button', { name: 'Open' }).click())
    await expectOpensTab(page, linkUrl, () => link.click({ modifiers: ['ControlOrMeta'] }))

    // leaving the link hides the popup; the cursor goes back to the end of the first line
    await noteContent(page).getByText('Hello from note A.').click()
    await page.keyboard.press('End')
    await expect(popup).toBeHidden()
    expect(cspViolations).toEqual([])
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

  await test.step('attach a PDF and a GPX to note A: the PDF previews, the GPX downloads', async () => {
    await attachFile(page, PDF)
    await attachFile(page, GPX)
    const content = noteContent(page)
    // the image is still there next to the two file chips
    await expect(content.locator('img[data-attachment-id]')).toHaveCount(1)
    await expect(content.locator('.attachment-file[data-kind="gpx"]')).toContainText(GPX.name)
    await expect(content.locator('.attachment-file[data-kind="pdf"]')).toContainText(PDF.name)
    // no viewer for a GPX
    await expect(content.locator('.attachment-file[data-kind="gpx"] .pdf-viewer')).toHaveCount(0)

    await expectPdfViewerWorks(content)
    await expectGpxDownload(page, content)

    // the stored content keeps only references (the image and both files), never a resolved URL
    const saved = JSON.stringify((await (await page.request.get(`/api/notes/${noteAId}`)).json()).note.content)
    expect(saved.match(/attachment:\/\/[0-9a-f-]{36}/g)).toHaveLength(3)
    expect(saved).not.toContain('/api/attachments/')
    expect(cspViolations).toEqual([])

    // PDF.js's standard-font data and CMaps are served same-origin from the build
    for (const asset of ['/pdfjs/standard_fonts/FoxitSerif.pfb', '/pdfjs/cmaps/78-H.bcmap']) {
      const res = await page.request.get(asset)
      expect(res.status(), asset).toBe(200)
      expect((await res.body()).length, asset).toBeGreaterThan(0)
    }
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
      const sharedCspViolations = await watchCsp(shared)
      const requested: string[] = []
      shared.on('request', (request) => requested.push(request.url()))
      await shared.goto(pinLink)
      await expect(shared.getByRole('heading', { name: 'This note is protected' })).toBeVisible()
      await shared.getByLabel('PIN').fill(pin)
      const unlocked = shared.waitForResponse(isPath(/^\/api\/shared\/[^/]+\/unlock$/, 'POST'))
      await shared.getByRole('button', { name: 'Unlock' }).click()
      const { token } = (await (await unlocked).json()) as { token: string }
      expect(token).toBeTruthy()

      await expect(shared.getByRole('heading', { name: 'Note A' })).toBeVisible()
      await expect(shared.getByText('Shared note · read-only')).toBeVisible()
      const content = shared.getByLabel('Shared note content')
      await expect(content).toContainText('Hello from note A.')
      // a plain click on a link opens it in a new tab; visitors get no link popup
      await expectOpensTab(shared, linkUrl, () => content.getByRole('link', { name: linkUrl }).click())
      await expect(shared.getByRole('group', { name: 'Link actions' })).toHaveCount(0)
      // read-only, and none of the owner app: no sidebar tree, toolbar or title field
      await expect(content).toHaveAttribute('contenteditable', 'false')
      await expect(shared.getByRole('tree')).toHaveCount(0)
      await expect(shared.getByRole('toolbar')).toHaveCount(0)
      await expect(shared.getByRole('textbox', { name: 'Note title' })).toHaveCount(0)
      // the image is fetched with the token in a header and shown as a blob URL
      const img = content.locator('img[data-attachment-id]')
      await expectImageLoaded(img, 8)
      await expect(img).toHaveAttribute('src', /^blob:/)
      // the PDF is previewed from bytes fetched with the token, and the GPX downloads as a named blob
      await expectPdfViewerWorks(content)
      await expectGpxDownload(shared, content)
      expect(sharedCspViolations).toEqual([])
      // the unlock token (and the PIN) stay in memory, never in the URL (the page's or any request's)
      expect(shared.url()).toBe(pinLink)
      const leaks = (secret: string) => (url: string) => url.includes(secret) || url.includes(encodeURIComponent(secret))
      expect(requested.filter(leaks(token))).toEqual([])
      expect(requested.filter(leaks(pin))).toEqual([])
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
