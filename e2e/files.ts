/**
 * Small PDF and GPX files generated in code (no binary fixtures), for the attachment E2E steps.
 */

/** RGB components in 0..1, as PDF's `rg` operator takes them. */
type Rgb = [number, number, number]

/**
 * A valid PDF whose pages are each filled with one color (page i gets `colors[i]`), `width`×`height`
 * points. Drawing only filled rectangles keeps it free of fonts, so PDF.js needs no font data.
 */
export function solidPdf(colors: Rgb[], width = 200, height = 120): Buffer {
  const pageCount = colors.length
  // objects: 1 catalog, 2 page tree, then per page a page object and its content stream
  const pageId = (i: number) => 3 + i * 2
  const contentId = (i: number) => 4 + i * 2
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${colors.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ]
  colors.forEach(([r, g, b], i) => {
    const stream = `${r} ${g} ${b} rg 0 0 ${width} ${height} re f`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents ${contentId(i)} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    )
  })

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  // every xref entry is exactly 20 bytes: 10-digit offset, space, 5-digit generation, space, type, space, LF
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/** A small GPX 1.1 track with the given name and points ([lat, lon]). */
export function gpxTrack(name: string, points: [number, number][]): Buffer {
  const trkpts = points.map(([lat, lon]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('\n')
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="notes-e2e" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`,
    'utf8',
  )
}
