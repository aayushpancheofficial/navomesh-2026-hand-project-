"""
NAVONMESH 26 - AI Prosthetic Hand Control System
Object Learning, Multi-Angle Capture, and Automatic Gripping Engine

Manages SQLite database storage for learned objects, 6-angle imagery (Front, Back, Left, Right, Top, Bottom),
heuristic & vision-based grip profile analysis, and calibrated servo angle mappings.
"""

import os
import time
import json
import sqlite3
import cv2
import numpy as np
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple

DB_PATH = os.path.join(os.path.dirname(__file__), "objects.db")
OBJECTS_IMG_DIR = os.path.join(os.path.dirname(__file__), "static", "captures", "objects")
os.makedirs(OBJECTS_IMG_DIR, exist_ok=True)


def get_db_connection() -> sqlite3.Connection:
    """Connect to SQLite database with foreign keys enabled and row factory."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_database():
    """Initialize SQLite tables for learned objects and multi-angle images."""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS learned_objects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        custom_name TEXT,
        category TEXT,
        grip_type TEXT,
        thumb_angle INTEGER DEFAULT 90,
        index_angle INTEGER DEFAULT 90,
        middle_angle INTEGER DEFAULT 90,
        ring_angle INTEGER DEFAULT 90,
        little_angle INTEGER DEFAULT 90,
        estimated_shape TEXT,
        estimated_size TEXT,
        orientation TEXT,
        confidence REAL DEFAULT 0.0,
        notes TEXT,
        thumbnail_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS object_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id INTEGER,
        angle_label TEXT,
        image_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(object_id) REFERENCES learned_objects(id) ON DELETE CASCADE
    );
    """)

    conn.commit()

    # Prepopulate with standard calibrated seed objects if table is empty
    cursor.execute("SELECT COUNT(*) AS count FROM learned_objects")
    count = cursor.fetchone()["count"]
    if count == 0:
        seed_objects = [
            {
                "name": "Apple",
                "custom_name": "Fresh Apple",
                "category": "Spherical Object",
                "grip_type": "Power Grip",
                "thumb_angle": 110,
                "index_angle": 125,
                "middle_angle": 130,
                "ring_angle": 125,
                "little_angle": 115,
                "estimated_shape": "Spherical / Round",
                "estimated_size": "Medium",
                "orientation": "Vertical",
                "confidence": 96.0,
                "notes": "5-finger enclosing power grip cradling the spherical fruit.",
                "thumbnail_url": "/static/images/helping_hand.png"
            },
            {
                "name": "Bottle",
                "custom_name": "Water Bottle",
                "category": "Cylindrical Object",
                "grip_type": "Cylindrical Grip",
                "thumb_angle": 120,
                "index_angle": 110,
                "middle_angle": 115,
                "ring_angle": 115,
                "little_angle": 105,
                "estimated_shape": "Cylindrical / Elongated",
                "estimated_size": "Medium",
                "orientation": "Vertical",
                "confidence": 95.0,
                "notes": "Full palmar wrap around bottle cylinder. Stable friction hold.",
                "thumbnail_url": "/static/images/helping_hand.png"
            },
            {
                "name": "Cup",
                "custom_name": "Ceramic Mug",
                "category": "Handled Object",
                "grip_type": "Pinch Grip",
                "thumb_angle": 85,
                "index_angle": 80,
                "middle_angle": 85,
                "ring_angle": 85,
                "little_angle": 80,
                "estimated_shape": "Cylindrical / Handled",
                "estimated_size": "Medium",
                "orientation": "Vertical",
                "confidence": 92.0,
                "notes": "Moderate closing diameter suitable for standard coffee mugs.",
                "thumbnail_url": "/static/images/helping_hand.png"
            },
            {
                "name": "Mobile",
                "custom_name": "Smartphone",
                "category": "Flat Rectangular",
                "grip_type": "Parallel Grip",
                "thumb_angle": 70,
                "index_angle": 65,
                "middle_angle": 60,
                "ring_angle": 45,
                "little_angle": 40,
                "estimated_shape": "Flat Rectangular",
                "estimated_size": "Medium",
                "orientation": "Vertical",
                "confidence": 90.0,
                "notes": "Parallel pinch grasp along bezel edges.",
                "thumbnail_url": "/static/images/helping_hand.png"
            }
        ]

        for s in seed_objects:
            cursor.execute("""
            INSERT INTO learned_objects (
                name, custom_name, category, grip_type,
                thumb_angle, index_angle, middle_angle, ring_angle, little_angle,
                estimated_shape, estimated_size, orientation, confidence, notes, thumbnail_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                s["name"], s["custom_name"], s["category"], s["grip_type"],
                s["thumb_angle"], s["index_angle"], s["middle_angle"], s["ring_angle"], s["little_angle"],
                s["estimated_shape"], s["estimated_size"], s["orientation"], s["confidence"], s["notes"], s.get("thumbnail_url", "/static/images/objects/apple.png")
            ))
        conn.commit()

    conn.close()


def analyze_image_geometry(img: np.ndarray, bbox: Optional[List[int]] = None) -> Dict[str, Any]:
    """
    Perform Computer Vision analysis on the object image or cropped ROI.
    Estimates shape, size, aspect ratio, orientation angle, and contour characteristics.
    """
    if img is None or img.size == 0:
        return {
            "shape": "Unknown",
            "size": "Medium",
            "orientation": "Normal",
            "aspect_ratio": 1.0,
            "grip_type": "Power Grip",
            "angles": [110, 125, 130, 125, 115]
        }

    h, w = img.shape[:2]

    # Crop to bbox if provided
    if bbox and len(bbox) == 4:
        bx1, by1, bx2, by2 = bbox
        bx1 = max(0, min(w - 1, int(bx1)))
        by1 = max(0, min(h - 1, int(by1)))
        bx2 = max(bx1 + 1, min(w, int(bx2)))
        by2 = max(by1 + 1, min(h, int(by2)))
        target_img = img[by1:by2, bx1:bx2]
    else:
        target_img = img
        bx1, by1, bx2, by2 = 0, 0, w, h

    th, tw = target_img.shape[:2]
    aspect_ratio = round(th / max(1, tw), 2)
    area_fraction = (th * tw) / max(1, (h * w))

    # Convert to grayscale and threshold
    gray = cv2.cvtColor(target_img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Otsu automatic thresholding
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    orientation_deg = 0.0
    circularity = 0.0

    if contours:
        largest_contour = max(contours, key=cv2.contourArea)
        c_area = cv2.contourArea(largest_contour)
        perimeter = cv2.arcLength(largest_contour, True)

        if perimeter > 0:
            circularity = (4 * np.pi * c_area) / (perimeter * perimeter)

        if len(largest_contour) >= 5:
            rect = cv2.minAreaRect(largest_contour)
            (rx, ry), (rw, rh), r_angle = rect
            orientation_deg = round(r_angle, 1)

    # Shape Classification
    if aspect_ratio >= 1.5:
        shape = "Cylindrical / Elongated"
    elif aspect_ratio <= 0.6:
        shape = "Horizontal Flat / Wide"
    elif circularity >= 0.65 or (0.8 <= aspect_ratio <= 1.25):
        shape = "Spherical / Round"
    else:
        shape = "Rectangular / Compact"

    # Size Classification
    if area_fraction < 0.06:
        size_class = "Small (< 6% field)"
    elif area_fraction > 0.35:
        size_class = "Large (> 35% field)"
    else:
        size_class = "Medium (Standard hand grasp)"

    # Orientation Description
    if abs(orientation_deg) < 15 or abs(orientation_deg - 90) < 15:
        if aspect_ratio >= 1.25:
            orient_str = "Vertical (0° alignment)"
        else:
            orient_str = "Horizontal (90° alignment)"
    else:
        orient_str = f"Tilted ({abs(orientation_deg):.0f}° angle)"

    # Recommended Grip Type and Calibrated Angles
    if "Spherical" in shape:
        grip_type = "Power Grip"
        angles = [110, 125, 130, 125, 115]
    elif "Cylindrical" in shape or aspect_ratio >= 1.5:
        grip_type = "Cylindrical Grip"
        angles = [120, 110, 115, 115, 105]
    elif "Small" in size_class or aspect_ratio <= 0.4:
        grip_type = "Pinch Grip"
        angles = [85, 80, 85, 85, 80]
    elif "Flat" in shape:
        grip_type = "Parallel Grip"
        angles = [70, 65, 60, 45, 40]
    else:
        grip_type = "Adaptive Power Grip"
        angles = [100, 95, 95, 90, 85]

    return {
        "shape": shape,
        "size": size_class,
        "orientation": orient_str,
        "aspect_ratio": aspect_ratio,
        "area_percentage": round(area_fraction * 100, 1),
        "grip_type": grip_type,
        "recommended_angles": angles,
        "thumb": angles[0],
        "index": angles[1],
        "middle": angles[2],
        "ring": angles[3],
        "little": angles[4]
    }


def list_learned_objects() -> List[Dict[str, Any]]:
    """Retrieve all learned objects from SQLite."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT o.*, COUNT(i.id) AS image_count
        FROM learned_objects o
        LEFT JOIN object_images i ON o.id = i.object_id
        GROUP BY o.id
        ORDER BY o.id ASC
    """)
    rows = cursor.fetchall()
    objects = []
    for r in rows:
        d = dict(r)
        d["servo_angles"] = [
            d["thumb_angle"],
            d["index_angle"],
            d["middle_angle"],
            d["ring_angle"],
            d["little_angle"]
        ]
        objects.append(d)
    conn.close()
    return objects


def get_learned_object(object_id: int) -> Optional[Dict[str, Any]]:
    """Retrieve a single learned object and its multi-angle images."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM learned_objects WHERE id = ?", (object_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None

    obj = dict(row)
    obj["servo_angles"] = [
        obj["thumb_angle"],
        obj["index_angle"],
        obj["middle_angle"],
        obj["ring_angle"],
        obj["little_angle"]
    ]

    cursor.execute("SELECT * FROM object_images WHERE object_id = ? ORDER BY id ASC", (object_id,))
    img_rows = cursor.fetchall()
    obj["images"] = [dict(ir) for ir in img_rows]

    conn.close()
    return obj


def save_learned_object(data: Dict[str, Any], images: Optional[List[Dict[str, str]]] = None) -> int:
    """
    Create a new learned object with grip profile and 6-angle images in SQLite.
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    name = data.get("name", "Unnamed Object").strip()
    custom_name = data.get("custom_name", name).strip()
    category = data.get("category", "General Object")
    grip_type = data.get("grip_type", "Power Grip")

    angles = data.get("servo_angles", [90, 90, 90, 90, 90])
    if len(angles) < 5:
        angles = angles + [90] * (5 - len(angles))

    thumb = int(data.get("thumb_angle", angles[0]))
    index_a = int(data.get("index_angle", angles[1]))
    middle = int(data.get("middle_angle", angles[2]))
    ring = int(data.get("ring_angle", angles[3]))
    little = int(data.get("little_angle", angles[4]))

    estimated_shape = data.get("estimated_shape", "Unknown")
    estimated_size = data.get("estimated_size", "Medium")
    orientation = data.get("orientation", "Normal")
    confidence = float(data.get("confidence", 95.0))
    notes = data.get("notes", "")
    thumbnail_url = data.get("thumbnail_url", "/static/images/helping_hand.png")

    cursor.execute("""
    INSERT INTO learned_objects (
        name, custom_name, category, grip_type,
        thumb_angle, index_angle, middle_angle, ring_angle, little_angle,
        estimated_shape, estimated_size, orientation, confidence, notes, thumbnail_url,
        created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    """, (
        name, custom_name, category, grip_type,
        thumb, index_a, middle, ring, little,
        estimated_shape, estimated_size, orientation, confidence, notes, thumbnail_url
    ))
    new_id = cursor.lastrowid

    # Save images if provided
    if images and new_id:
        for idx, img_info in enumerate(images):
            angle_label = img_info.get("angle_label", f"Angle {idx+1}")
            image_path = img_info.get("image_path", "")
            cursor.execute("""
            INSERT INTO object_images (object_id, angle_label, image_path)
            VALUES (?, ?, ?)
            """, (new_id, angle_label, image_path))

            if (idx == 0 or angle_label.lower() == "front") and image_path:
                cursor.execute("UPDATE learned_objects SET thumbnail_url = ? WHERE id = ?", (image_path, new_id))

    conn.commit()
    conn.close()
    return new_id


def update_learned_object(object_id: int, data: Dict[str, Any]) -> bool:
    """Update fields and calibrated servo angles for a learned object."""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT id FROM learned_objects WHERE id = ?", (object_id,))
    if not cursor.fetchone():
        conn.close()
        return False

    fields = []
    values = []

    for key in ["name", "custom_name", "category", "grip_type", "estimated_shape",
                "estimated_size", "orientation", "notes", "thumbnail_url"]:
        if key in data:
            fields.append(f"{key} = ?")
            values.append(data[key])

    for key in ["thumb_angle", "index_angle", "middle_angle", "ring_angle", "little_angle"]:
        if key in data:
            fields.append(f"{key} = ?")
            values.append(int(data[key]))

    if "servo_angles" in data and len(data["servo_angles"]) >= 5:
        for idx, k in enumerate(["thumb_angle", "index_angle", "middle_angle", "ring_angle", "little_angle"]):
            fields.append(f"{k} = ?")
            values.append(int(data["servo_angles"][idx]))

    if not fields:
        conn.close()
        return True

    fields.append("updated_at = CURRENT_TIMESTAMP")
    values.append(object_id)

    query = f"UPDATE learned_objects SET {', '.join(fields)} WHERE id = ?"
    cursor.execute(query, tuple(values))
    conn.commit()
    conn.close()
    return True


def delete_learned_object(object_id: int) -> bool:
    """Delete a learned object and remove its image files from disk."""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT image_path FROM object_images WHERE object_id = ?", (object_id,))
    rows = cursor.fetchall()
    for r in rows:
        path = r["image_path"]
        if path.startswith("/static/"):
            rel_path = path[1:]
            abs_path = os.path.join(os.path.dirname(__file__), rel_path)
            if os.path.exists(abs_path):
                try:
                    os.remove(abs_path)
                except Exception:
                    pass

    cursor.execute("DELETE FROM learned_objects WHERE id = ?", (object_id,))
    rows_affected = cursor.rowcount
    conn.commit()
    conn.close()
    return rows_affected > 0


def find_matching_learned_object(label: str) -> Optional[Dict[str, Any]]:
    """Match a detected YOLO label or object name against the SQLite database."""
    if not label:
        return None
    clean = label.strip().lower()

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM learned_objects WHERE LOWER(name) LIKE ? OR LOWER(custom_name) LIKE ? LIMIT 1",
                   (f"%{clean}%", f"%{clean}%"))
    row = cursor.fetchone()
    conn.close()

    if row:
        d = dict(row)
        d["servo_angles"] = [
            d["thumb_angle"],
            d["index_angle"],
            d["middle_angle"],
            d["ring_angle"],
            d["little_angle"]
        ]
        return d
    return None


# Initialize database upon import
init_database()

