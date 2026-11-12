import { fileDownloadName, fileNameFromDisposition } from './download'

describe('fileNameFromDisposition', () => {
  it('prefers the UTF-8 filename*, falls back to the quoted filename, and is null without either', () => {
    expect(fileNameFromDisposition(`attachment; filename="a_b.pdf"; filename*=UTF-8''a%22b%3B.pdf`)).toBe('a"b;.pdf')
    expect(fileNameFromDisposition('attachment; filename="plain.gpx"')).toBe('plain.gpx')
    expect(fileNameFromDisposition(`attachment; filename="safe.pdf"; filename*=UTF-8''%E0%A4%A.pdf`)).toBe('safe.pdf')
    expect(fileNameFromDisposition(`inline; filename="cat.png"; filename*=UTF-8''cat.png`)).toBe('cat.png')
    expect(fileNameFromDisposition('attachment')).toBeNull()
    expect(fileNameFromDisposition(null)).toBeNull()
  })

  it("never takes a filename*= that sits inside the quoted filename for the parameter", () => {
    // what a server that left * = ' in the ASCII fallback would send for the name `a filename*=UTF-8''x.exe.pdf`
    const crafted = `a filename*=UTF-8''x.exe.pdf`
    expect(
      fileNameFromDisposition(`attachment; filename="${crafted}"; filename*=UTF-8''a%20filename%2A%3DUTF-8%27%27x.exe.pdf`),
    ).toBe(crafted)
    expect(fileNameFromDisposition(`attachment; filename="${crafted}"`)).toBe(crafted)
    expect(fileNameFromDisposition(`attachment; filename="a filename*=UTF-8''x.exe"`)).toBe(`a filename*=UTF-8''x.exe`)
  })
})

describe('fileDownloadName', () => {
  const headers = (type: string | null, disposition: string | null) => {
    const h = new Headers()
    if (type !== null) h.set('content-type', type)
    if (disposition !== null) h.set('content-disposition', disposition)
    return h
  }

  it.each([
    ['application/pdf', `attachment; filename="Route.pdf"; filename*=UTF-8''Route.pdf`, 'Route.pdf'],
    ['application/gpx+xml', `attachment; filename="Ridge.GPX"`, 'Ridge.GPX'],
    ['Application/PDF; charset=binary', `attachment; filename="a.pdf"`, 'a.pdf'],
  ])('%s with %s → %j', (type, disposition, expected) => {
    expect(fileDownloadName(headers(type, disposition))).toBe(expected)
  })

  it.each([
    ['an image', 'image/png', `inline; filename="x.js.png"; filename*=UTF-8''x.js.png`],
    ['an image whose name is a PDF name', 'image/png', `inline; filename="x.pdf"`],
    ['no content type', null, `attachment; filename="a.pdf"`],
    ['an unknown type', 'text/html', `attachment; filename="a.pdf"`],
    ['no Content-Disposition', 'application/pdf', null],
    ['an unparseable Content-Disposition', 'application/pdf', 'attachment'],
    ['a name with another extension', 'application/pdf', `attachment; filename="x.js"`],
    ['a GPX named as a PDF', 'application/gpx+xml', `attachment; filename="x.pdf"`],
  ])('is null for %s', (_name, type, disposition) => {
    expect(fileDownloadName(headers(type, disposition))).toBeNull()
  })
})
