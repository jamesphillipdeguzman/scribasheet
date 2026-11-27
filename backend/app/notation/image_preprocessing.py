"""Validation and conditional OMR preprocessing for sheet music images (JPG, JPEG, PNG, WebP)."""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage

SUPPORTED_SHEET_IMAGE_EXTENSIONS: frozenset[str] = frozenset({".jpg", ".jpeg", ".png", ".webp"})
SUPPORTED_SHEET_IMAGE_MIMES: frozenset[str] = frozenset(
    {"image/jpeg", "image/jpg", "image/png", "image/webp"}
)
ALLOWED_PIL_FORMATS: frozenset[str] = frozenset({"JPEG", "PNG", "WEBP"})
FORMAT_TO_CANONICAL_MIME: dict[str, str] = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}

MIN_IMAGE_DIMENSION = 64
MAX_IMAGE_PIXELS = 80_000_000


class SheetImageValidationError(ValueError):
    """Raised when an uploaded sheet music image fails extension, MIME, magic-byte, or decode checks."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ImageValidationInfo:
    format: str
    mime_type: str
    width: int
    height: int
    size_bytes: int


@dataclass(frozen=True)
class ImagePreprocessReport:
    original_size: tuple[int, int]
    output_size: tuple[int, int]
    was_clean_scan: bool
    cropped: bool
    skew_angle_deg: float
    deskewed: bool
    lighting_normalized: bool
    resized: bool
    applied_steps: tuple[str, ...]


def is_supported_sheet_image_filename(filename: str | None) -> bool:
    ext = Path((filename or "").strip().lower()).suffix
    return ext in SUPPORTED_SHEET_IMAGE_EXTENSIONS


def is_supported_sheet_image_mime(mime_type: str | None) -> bool:
    low = (mime_type or "").split(";", 1)[0].strip().lower()
    return low in SUPPORTED_SHEET_IMAGE_MIMES


def _detect_magic_format(data: bytes) -> str | None:
    if len(data) < 12:
        return None
    if data.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


def validate_sheet_image_bytes(
    data: bytes,
    filename: str,
    declared_mime: str | None = None,
) -> ImageValidationInfo:
    """Validate actual image content (magic bytes + full Pillow decode) and extension/MIME compatibility."""
    if not data or len(data) < 16:
        raise SheetImageValidationError("EMPTY_IMAGE", "Uploaded image file is empty or too small.")

    safe_name = Path(filename or "").name
    ext = Path(safe_name).suffix.lower()
    if ext not in SUPPORTED_SHEET_IMAGE_EXTENSIONS:
        raise SheetImageValidationError(
            "UNSUPPORTED_IMAGE_FORMAT",
            f"Unsupported image extension '{ext or '(none)'}'. Supported formats: .jpg, .jpeg, .png, .webp.",
        )

    clean_mime = (declared_mime or "").split(";", 1)[0].strip().lower()
    if clean_mime and clean_mime not in SUPPORTED_SHEET_IMAGE_MIMES | {
        "application/octet-stream",
        "binary/octet-stream",
    }:
        raise SheetImageValidationError(
            "INVALID_IMAGE_MIME",
            f"Unsupported MIME type '{declared_mime}' for sheet music image '{safe_name}'.",
        )

    magic_fmt = _detect_magic_format(data)
    if magic_fmt not in ALLOWED_PIL_FORMATS:
        raise SheetImageValidationError(
            "INVALID_IMAGE",
            f"File '{safe_name}' does not appear to be a valid JPG, PNG, or WebP image.",
        )

    expected_ext_formats = {
        ".jpg": "JPEG",
        ".jpeg": "JPEG",
        ".png": "PNG",
        ".webp": "WEBP",
    }
    if expected_ext_formats.get(ext) != magic_fmt:
        raise SheetImageValidationError(
            "INVALID_IMAGE",
            f"File '{safe_name}' content ({magic_fmt}) does not match its '{ext}' extension.",
        )

    try:
        with Image.open(io.BytesIO(data)) as verify_img:
            img_fmt = (verify_img.format or "").upper()
            if img_fmt not in ALLOWED_PIL_FORMATS or img_fmt != magic_fmt:
                raise SheetImageValidationError(
                    "INVALID_IMAGE",
                    f"Unsupported or mismatched image format in '{safe_name}'.",
                )
            w, h = verify_img.size
            if w < MIN_IMAGE_DIMENSION or h < MIN_IMAGE_DIMENSION:
                raise SheetImageValidationError(
                    "IMAGE_TOO_SMALL",
                    f"Image '{safe_name}' ({w}x{h}) is too small for sheet music recognition (minimum {MIN_IMAGE_DIMENSION}x{MIN_IMAGE_DIMENSION}).",
                )
            if w * h > MAX_IMAGE_PIXELS:
                raise SheetImageValidationError(
                    "IMAGE_TOO_LARGE",
                    f"Image '{safe_name}' resolution ({w}x{h}) exceeds maximum supported pixel limit.",
                )
            verify_img.verify()

        # Reopen and force full pixel decode to catch truncated or corrupted streams
        with Image.open(io.BytesIO(data)) as load_img:
            load_img.load()
            w, h = load_img.size
            canonical_fmt = (load_img.format or magic_fmt).upper()
    except SheetImageValidationError:
        raise
    except Exception as exc:
        raise SheetImageValidationError(
            "CORRUPTED_IMAGE",
            f"Image '{safe_name}' could not be decoded: {exc}",
        ) from exc

    return ImageValidationInfo(
        format=canonical_fmt,
        mime_type=FORMAT_TO_CANONICAL_MIME.get(canonical_fmt, "image/png"),
        width=int(w),
        height=int(h),
        size_bytes=len(data),
    )


def _pil_to_clean_grayscale(img: Image.Image) -> Image.Image:
    """Apply EXIF orientation and flatten transparency onto white background in grayscale ('L')."""
    oriented = ImageOps.exif_transpose(img)
    if oriented.mode in ("RGBA", "LA") or (oriented.mode == "P" and "transparency" in oriented.info):
        rgba = oriented.convert("RGBA")
        white_bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        composited = Image.alpha_composite(white_bg, rgba)
        return composited.convert("L")
    if oriented.mode != "L":
        return oriented.convert("L")
    return oriented.copy()


def _assess_image_quality(gray: np.ndarray) -> tuple[bool, float, float, float]:
    """Return (is_clean_scan, bg_std, white_bg_fraction, contrast_span)."""
    h, w = gray.shape
    sigma = float(max(20, min(h, w) // 32))
    bg = ndimage.gaussian_filter(gray.astype(np.float32), sigma=sigma)
    bg_std = float(np.std(bg))
    white_bg_fraction = float(np.mean(gray >= 235))
    # Sheet music ink can cover under 1% of a clean page, so sample low percentile at 0.2%.
    p_ink, p_paper = np.percentile(gray, [0.2, 95.0])
    contrast_span = float(p_paper - p_ink)
    is_clean = (bg_std < 8.5) and (white_bg_fraction >= 0.70) and (contrast_span >= 150.0)
    return is_clean, bg_std, white_bg_fraction, contrast_span


def _detect_unnecessary_border_bbox(
    gray: np.ndarray,
    *,
    is_clean_scan: bool,
) -> tuple[int, int, int, int] | None:
    """Detect outer dark desk border or overly wide uniform blank margin without clipping notation."""
    h, w = gray.shape
    if h < 200 or w < 200:
        return None

    margin_y = max(4, int(0.03 * h))
    margin_x = max(4, int(0.03 * w))
    top_mean = float(np.mean(gray[:margin_y, :]))
    bot_mean = float(np.mean(gray[h - margin_y :, :]))
    left_mean = float(np.mean(gray[:, :margin_x]))
    right_mean = float(np.mean(gray[:, w - margin_x :]))
    outer_min = min(top_mean, bot_mean, left_mean, right_mean)

    # Clean white-margin scan: preserve existing scan geometry cleanly
    if is_clean_scan and outer_min >= 235.0:
        return None

    # Downsample for robust region analysis
    scale = min(1.0, 600.0 / max(h, w))
    sw = max(80, int(round(w * scale)))
    sh = max(80, int(round(h * scale)))
    small = np.asarray(Image.fromarray(gray).resize((sw, sh), Image.Resampling.BILINEAR), dtype=np.float32)

    center_med = float(np.median(small[sh // 4 : (3 * sh) // 4, sw // 4 : (3 * sw) // 4]))
    dark_outer = outer_min < min(155.0, center_med - 35.0) and center_med >= 120.0

    y0_s, y1_s, x0_s, x1_s = 0, sh, 0, sw
    found_crop = False

    if dark_outer:
        # Trim rows/columns belonging predominantly to dark outer surround
        row_q75 = np.percentile(small, 75, axis=1)
        col_q75 = np.percentile(small, 75, axis=0)
        page_thresh = max(110.0, center_med * 0.72)
        valid_rows = np.where(row_q75 >= page_thresh)[0]
        valid_cols = np.where(col_q75 >= page_thresh)[0]
        if valid_rows.size >= sh * 0.35 and valid_cols.size >= sw * 0.35:
            y0_s = int(valid_rows[0])
            y1_s = int(valid_rows[-1]) + 1
            x0_s = int(valid_cols[0])
            x1_s = int(valid_cols[-1]) + 1
            found_crop = True
    else:
        # Check for large empty margins (>10% uniform blank borders) around actual score ink
        bg = ndimage.gaussian_filter(small, sigma=max(8.0, min(sw, sh) / 28.0))
        ink = (bg - small) > 16.0
        row_ink = ink.mean(axis=1) > 0.008
        col_ink = ink.mean(axis=0) > 0.008
        ink_rows = np.where(row_ink)[0]
        ink_cols = np.where(col_ink)[0]
        if ink_rows.size >= sh * 0.20 and ink_cols.size >= sw * 0.20:
            y0_s = int(ink_rows[0])
            y1_s = int(ink_rows[-1]) + 1
            x0_s = int(ink_cols[0])
            x1_s = int(ink_cols[-1]) + 1
            found_crop = True

    if not found_crop:
        return None

    inv_scale = 1.0 / scale
    pad = max(36, int(0.035 * min(h, w)))
    x0 = max(0, int(round(x0_s * inv_scale)) - pad)
    y0 = max(0, int(round(y0_s * inv_scale)) - pad)
    x1 = min(w, int(round(x1_s * inv_scale)) + pad)
    y1 = min(h, int(round(y1_s * inv_scale)) + pad)

    crop_w = x1 - x0
    crop_h = y1 - y0
    if crop_w < 200 or crop_h < 200:
        return None
    area_ratio = (crop_w * crop_h) / float(w * h)
    # Only apply crop when removing meaningful border (>10% area reduction) and keeping page content
    if area_ratio <= 0.90 and area_ratio >= 0.20:
        return (x0, y0, x1, y1)
    return None


def _estimate_skew_angle(gray: np.ndarray) -> tuple[float, bool]:
    """Estimate minor rotation angle (in degrees) using staff-line projection variance."""
    h, w = gray.shape
    if min(h, w) < 160:
        return 0.0, False

    scale = min(1.0, 900.0 / max(h, w))
    sw = max(100, int(round(w * scale)))
    sh = max(100, int(round(h * scale)))
    small = np.asarray(Image.fromarray(gray).resize((sw, sh), Image.Resampling.BILINEAR), dtype=np.float32)

    # Local ink emphasis removes uneven lighting before evaluating horizontal staff-line alignment
    bg = ndimage.gaussian_filter(small, sigma=max(10.0, min(sw, sh) / 36.0))
    ink = np.clip(bg - small, 0.0, 255.0)
    if float(np.max(ink)) < 12.0:
        return 0.0, False

    # Strip outer 6% margins to ignore frame/border edges during angle scoring
    ym = max(4, int(0.06 * sh))
    xm = max(4, int(0.06 * sw))
    core = ink[ym : sh - ym, xm : sw - xm]
    if core.shape[0] < 40 or core.shape[1] < 40:
        core = ink

    def score_angle(deg: float) -> float:
        if abs(deg) < 1e-6:
            proj = core.mean(axis=1)
        else:
            rot = ndimage.rotate(core, deg, reshape=False, order=1, mode="constant", cval=0.0)
            proj = rot.mean(axis=1)
        return float(np.var(proj))

    zero_score = score_angle(0.0)
    if zero_score <= 1e-6:
        return 0.0, False

    coarse_angles = np.arange(-7.0, 7.01, 0.5)
    best_angle = 0.0
    best_score = zero_score
    for deg in coarse_angles:
        s = score_angle(float(deg))
        if s > best_score:
            best_score = s
            best_angle = float(deg)

    # Fine refinement ±0.6 deg around peak
    fine_angles = np.arange(best_angle - 0.6, best_angle + 0.61, 0.15)
    for deg in fine_angles:
        s = score_angle(float(deg))
        if s > best_score:
            best_score = s
            best_angle = float(deg)

    should_deskew = abs(best_angle) >= 0.45 and best_score >= zero_score * 1.12
    return round(best_angle, 2), should_deskew


def _normalize_lighting_and_contrast(gray: np.ndarray) -> np.ndarray:
    """Correct uneven shadows/lighting and boost contrast smoothly while keeping thin notation lines intact."""
    h, w = gray.shape
    gray_f = gray.astype(np.float32)
    sigma = float(max(24, min(h, w) // 26))
    illum = ndimage.gaussian_filter(gray_f, sigma=sigma)

    # Divide out slow illumination gradient and target clean bright paper background
    norm = np.clip((gray_f / np.maximum(illum, 30.0)) * 250.0, 0.0, 255.0)

    # Gentle soft-percentile stretch preserves anti-aliased staff lines, slurs, ties, and dynamics
    p_low = float(np.percentile(norm, 1.5))
    p_high = float(np.percentile(norm, 93.5))
    if p_high - p_low >= 20.0:
        stretched = ((norm - p_low) / (p_high - p_low)) * 255.0
        stretched = np.clip(stretched, 0.0, 255.0)
    else:
        stretched = norm
    return np.round(stretched).astype(np.uint8)


def preprocess_sheet_image_for_omr(input_path: Path, output_path: Path) -> ImagePreprocessReport:
    """Conditionally preprocess a sheet music photo/scan to a clean PNG for OMR without mutating input_path."""
    applied_steps: list[str] = []

    with Image.open(input_path) as raw_img:
        gray_img = _pil_to_clean_grayscale(raw_img)

    orig_size = gray_img.size
    gray_arr = np.asarray(gray_img, dtype=np.uint8)
    is_clean_scan, _, _, _ = _assess_image_quality(gray_arr)

    # 1. Conditional border detection & cropping (trim desk/shadow surrounds or huge empty margins)
    cropped = False
    bbox = _detect_unnecessary_border_bbox(gray_arr, is_clean_scan=is_clean_scan)
    if bbox is not None:
        gray_img = gray_img.crop(bbox)
        gray_arr = np.asarray(gray_img, dtype=np.uint8)
        cropped = True
        applied_steps.append("crop_borders")
        is_clean_scan, _, _, _ = _assess_image_quality(gray_arr)

    # 2. Conditional deskewing when minor rotation is reliably detected
    skew_angle, should_deskew = _estimate_skew_angle(gray_arr)
    if should_deskew:
        gray_img = gray_img.rotate(
            skew_angle,
            resample=Image.Resampling.BICUBIC,
            expand=True,
            fillcolor=255,
        )
        gray_arr = np.asarray(gray_img, dtype=np.uint8)
        applied_steps.append("deskew")

    # 3. Conditional lighting & contrast normalization (skip for already-clean scans)
    lighting_normalized = False
    if not is_clean_scan:
        gray_arr = _normalize_lighting_and_contrast(gray_arr)
        gray_img = Image.fromarray(gray_arr, mode="L")
        lighting_normalized = True
        applied_steps.append("normalize_lighting_contrast")

    # 4. Conditional resolution normalization (never blindly upscale crisp high-res images)
    cur_w, cur_h = gray_img.size
    resized = False
    if cur_w < 1200 and max(cur_w, cur_h) < 1600:
        scale_up = min(2.5, 1800.0 / max(1, cur_w))
        if scale_up > 1.05:
            new_w = max(cur_w, int(round(cur_w * scale_up)))
            new_h = max(cur_h, int(round(cur_h * scale_up)))
            gray_img = gray_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
            resized = True
            applied_steps.append("upscale_small")
    elif max(cur_w, cur_h) > 3800:
        scale_down = 3200.0 / float(max(cur_w, cur_h))
        new_w = max(64, int(round(cur_w * scale_down)))
        new_h = max(64, int(round(cur_h * scale_down)))
        gray_img = gray_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        resized = True
        applied_steps.append("downscale_oversized")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    gray_img.save(output_path, format="PNG")

    return ImagePreprocessReport(
        original_size=orig_size,
        output_size=gray_img.size,
        was_clean_scan=is_clean_scan,
        cropped=cropped,
        skew_angle_deg=skew_angle,
        deskewed=should_deskew,
        lighting_normalized=lighting_normalized,
        resized=resized,
        applied_steps=tuple(applied_steps),
    )
