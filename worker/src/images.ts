import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"

function createPaddedData(
  sourceData: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Buffer {
  // Initialize with transparent black (RGBA 0, 0, 0, 0)
  const targetData = Buffer.alloc(targetWidth * targetHeight * 4)
  // Since widths are equal, we can copy the entire source data block directly.
  // It will occupy the top sourceHeight rows of the target buffer.
  sourceData.copy(
    targetData,
    0, // Target start index
    0, // Source start index
    sourceWidth * sourceHeight * 4, // Source end index (total bytes in source)
  )
  return targetData
}

export function diffImages(
  newImage: PNG,
  baselineImage: PNG,
): { diffRatio: number; numDiffPixels: number; diffMask: PNG } {
  if (newImage.width !== baselineImage.width) {
    throw new Error(
      `Image widths must match for comparison: ${newImage.width} vs ${baselineImage.width}`,
    )
  }

  const width = newImage.width
  const height1 = newImage.height
  const height2 = baselineImage.height
  const maxHeight = Math.max(height1, height2)

  let data1 = newImage.data
  let data2 = baselineImage.data

  // If heights differ, pad the shorter image's data
  if (height1 !== height2) {
    data1 = createPaddedData(newImage.data, width, height1, width, maxHeight)
    data2 = createPaddedData(baselineImage.data, width, height2, width, maxHeight)
  }

  const diffPng = new PNG({ width, height: maxHeight })
  const numDiffPixels = pixelmatch(data1, data2, diffPng.data, width, maxHeight, {
    // Matching threshold, ranges from 0 to 1. Smaller values make the comparison more
    // sensitive. 0.1 by default.
    threshold: 0.09,
    // Include pixels detected as anti-aliasing in the diff output.
    includeAA: true,
    // The color of differing pixels in the diff output in [R, G, B] format. [255, 0, 0]
    // by default.
    diffColor: [255, 255, 255],
    // Draw the diff over a transparent background (a mask), rather than over the original
    // image. Will not draw anti-aliased pixels (if detected).
    diffMask: true,
  })
  // Calculate ratio based on the total pixels of the larger dimension area
  const diffRatio = numDiffPixels / (width * maxHeight)

  return { diffRatio, numDiffPixels, diffMask: diffPng }
}

export function diffImagesNoMask(newImage: PNG, baselineImage: PNG): number {
  const numDiffPixels = pixelmatch(
    newImage.data,
    baselineImage.data,
    undefined,
    newImage.width,
    newImage.height,
    {
      threshold: 0.08, // Use a more sensitive threshold than the primary diff
      includeAA: true, // Enable anti-aliasing detection
    },
  )
  return numDiffPixels / (newImage.width * newImage.height)
}
