"""
NAVONMESH AI Prosthetic Hand - Phase 1
Grasp Suitability and Object Classification Engine

Provides rule-based preliminary grasp recommendations and categories for detected objects.
NOTE: These assessments are preliminary category heuristics based on 2D visual recognition.
Physical properties (weight, mass distribution, surface friction, internal contents)
cannot be definitively verified from a single monocular webcam feed.
"""

from typing import Dict, Any, Tuple

# Confidence tier classification
def get_confidence_tier(confidence: float) -> str:
    """Classify confidence score into defined tiers."""
    pct = confidence * 100 if confidence <= 1.0 else confidence
    if pct >= 90.0:
        return "Very High"
    elif pct >= 75.0:
        return "High"
    elif pct >= 50.0:
        return "Medium"
    else:
        return "Low"


# Knowledge base of grasp profiles for common COCO / YOLO objects
GRASP_PROFILES: Dict[str, Dict[str, str]] = {
    "bottle": {
        "display_name": "Water Bottle / Bottle",
        "category": "Cylindrical Object",
        "grasp_suitability": "Suitable for evaluation",
        "suggested_grip": "Cylindrical / Power Grip",
        "recommendation": "Potentially Pickable",
        "notes": "Verify diameter and liquid fullness before grip application."
    },
    "cup": {
        "display_name": "Cup / Mug",
        "category": "Handled / Cylindrical Object",
        "grasp_suitability": "Suitable for evaluation",
        "suggested_grip": "Cylindrical Wrap or Top-Rim Pinch",
        "recommendation": "Potentially Pickable",
        "notes": "Hot liquids require temperature check and secure orientation."
    },
    "wine glass": {
        "display_name": "Wine Glass / Glass",
        "category": "Fragile Stemmed Glassware",
        "grasp_suitability": "High fragility - requires sensitive tactile feedback",
        "suggested_grip": "Precision Finger / Stem Pinch Grip",
        "recommendation": "Pick with Caution (Fragile)",
        "notes": "Excessive force will shatter glass. Minimum force required."
    },
    "cell phone": {
        "display_name": "Mobile Phone",
        "category": "Flat Rectangular Device",
        "grasp_suitability": "Depends on size, thickness, and orientation",
        "suggested_grip": "Precision / Pinch Grip",
        "recommendation": "Requires further evaluation",
        "notes": "Flat surfaces on tables may require edge slide or lateral pinch."
    },
    "laptop": {
        "display_name": "Laptop Computer",
        "category": "Large Electronic Device",
        "grasp_suitability": "Too large / heavy for single prosthetic hand",
        "suggested_grip": "Two-Hand Platform Support / Dual Lift",
        "recommendation": "Unsuitable for single-hand pick",
        "notes": "Exceeds standard 5-finger prosthetic payload capacity."
    },
    "keyboard": {
        "display_name": "Computer Keyboard",
        "category": "Elongated Flat Object",
        "grasp_suitability": "Wide surface span; orientation sensitive",
        "suggested_grip": "Extended Palmar / Wide Span Grip",
        "recommendation": "Requires further evaluation",
        "notes": "Best lifted from side edges with dual support."
    },
    "mouse": {
        "display_name": "Computer Mouse",
        "category": "Ergonomic Handheld Object",
        "grasp_suitability": "Well-suited for natural hand curvature",
        "suggested_grip": "Spherical / Palmar Grip",
        "recommendation": "Potentially Pickable",
        "notes": "Lightweight, easily encompassed by 5-finger flexure."
    },
    "book": {
        "display_name": "Book / Notebook",
        "category": "Flat Rectangular Object",
        "grasp_suitability": "Depends on thickness, orientation, and binding",
        "suggested_grip": "Lateral / Key Pinch or Power Grip",
        "recommendation": "Requires further evaluation",
        "notes": "Thin books lying flat require lifting edge first."
    },
    "pen": {
        "display_name": "Pen / Pencil",
        "category": "Thin Cylindrical Tool",
        "grasp_suitability": "Requires fine motor coordination",
        "suggested_grip": "Tripod / Precision Pinch Grip",
        "recommendation": "Potentially Pickable",
        "notes": "Requires fine tip precision between thumb and index."
    },
    "scissors": {
        "display_name": "Scissors",
        "category": "Handheld Tool (Sharp)",
        "grasp_suitability": "Sharp blades - requires strict approach orientation",
        "suggested_grip": "Handle Loop / Precision Grip",
        "recommendation": "Pick with Caution (Sharp)",
        "notes": "Only grasp from insulated handle loops; keep blades clear."
    },
    "apple": {
        "display_name": "Apple",
        "category": "Spherical Fruit / Small Object",
        "grasp_suitability": "Naturally contours to palm and finger enclosure",
        "suggested_grip": "Spherical / 5-Finger Enclosing Grip",
        "recommendation": "Potentially Pickable",
        "notes": "Soft skin - moderate compliance recommended."
    },
    "orange": {
        "display_name": "Orange",
        "category": "Spherical Fruit / Small Object",
        "grasp_suitability": "Naturally contours to palm and finger enclosure",
        "suggested_grip": "Spherical / 5-Finger Enclosing Grip",
        "recommendation": "Potentially Pickable",
        "notes": "Uniform shape facilitates balanced grasp."
    },
    "banana": {
        "display_name": "Banana",
        "category": "Curved Elongated Organic",
        "grasp_suitability": "Asymmetric curvature requires adaptive finger wrap",
        "suggested_grip": "Hook / Cylindrical Wrap Grip",
        "recommendation": "Potentially Pickable",
        "notes": "Soft tissue; avoid excessive pinch at single contact point."
    },
    "fork": {
        "display_name": "Fork",
        "category": "Cutlery / Handheld Utensil",
        "grasp_suitability": "Slender handle",
        "suggested_grip": "Precision / Finger Tip Pinch",
        "recommendation": "Potentially Pickable",
        "notes": "Approach from stem handle."
    },
    "knife": {
        "display_name": "Knife",
        "category": "Cutlery / Sharp Utensil",
        "grasp_suitability": "High hazard risk - sharp edge",
        "suggested_grip": "Handle Power Grip (Handle Only)",
        "recommendation": "Pick with Caution (Sharp)",
        "notes": "Safety restriction: Grip must strictly avoid blade edge."
    },
    "spoon": {
        "display_name": "Spoon",
        "category": "Cutlery / Handheld Utensil",
        "grasp_suitability": "Slender handle",
        "suggested_grip": "Precision / Finger Tip Pinch",
        "recommendation": "Potentially Pickable",
        "notes": "Lightweight, easy precision pick."
    },
    "bowl": {
        "display_name": "Bowl",
        "category": "Hemispherical Container",
        "grasp_suitability": "Open rim geometry or bottom cupping",
        "suggested_grip": "Spherical / Rim Pinch Grip",
        "recommendation": "Potentially Pickable",
        "notes": "Check for hot contents or liquid instability."
    },
    "remote": {
        "display_name": "Remote Control",
        "category": "Handheld Rectangular Device",
        "grasp_suitability": "Suitable for hand enclosure",
        "suggested_grip": "Palmar / Cylindrical Wrap Grip",
        "recommendation": "Potentially Pickable",
        "notes": "Compact handheld form factor."
    },
    "toothbrush": {
        "display_name": "Toothbrush",
        "category": "Thin Slender Tool",
        "grasp_suitability": "Small cross-section",
        "suggested_grip": "Precision Pinch Grip",
        "recommendation": "Potentially Pickable",
        "notes": "Lightweight slender shaft."
    },
    "chair": {
        "display_name": "Chair",
        "category": "Heavy Structural Furniture",
        "grasp_suitability": "Immense weight / immovable by single hand",
        "suggested_grip": "Not Applicable",
        "recommendation": "Unsuitable for picking (Structural)",
        "notes": "Structural furniture. Exceeds load envelope."
    },
    "couch": {
        "display_name": "Couch / Sofa",
        "category": "Heavy Structural Furniture",
        "grasp_suitability": "Immense weight / immovable",
        "suggested_grip": "Not Applicable",
        "recommendation": "Unsuitable for picking (Structural)",
        "notes": "Structural furniture."
    },
    "bed": {
        "display_name": "Bed",
        "category": "Heavy Structural Furniture",
        "grasp_suitability": "Immense weight / immovable",
        "suggested_grip": "Not Applicable",
        "recommendation": "Unsuitable for picking (Structural)",
        "notes": "Structural furniture."
    },
    "dining table": {
        "display_name": "Dining Table",
        "category": "Heavy Structural Furniture",
        "grasp_suitability": "Immense weight / immovable",
        "suggested_grip": "Not Applicable",
        "recommendation": "Unsuitable for picking (Structural)",
        "notes": "Structural furniture."
    },
    "person": {
        "display_name": "Person",
        "category": "Human Being",
        "grasp_suitability": "Safety Lock Engaged - No autonomous grasp",
        "suggested_grip": "Not Applicable",
        "recommendation": "Unsuitable for picking (Safety Lock)",
        "notes": "Prosthetic hand safety protocol: Human interaction requires manual operator mode."
    }
}


def analyze_grasp(label: str, confidence: float, bbox: Tuple[int, int, int, int] = None) -> Dict[str, Any]:
    """
    Generate grasp assessment for a detected object class.
    
    Args:
        label: Lowercase class name from detector
        confidence: Detection confidence (0.0 to 1.0)
        bbox: Optional (x1, y1, x2, y2) bounding box
    
    Returns:
        Structured dictionary of grasp suitability parameters.
    """
    clean_label = label.strip().lower()
    profile = GRASP_PROFILES.get(clean_label)
    
    confidence_tier = get_confidence_tier(confidence)
    confidence_pct = round(confidence * 100 if confidence <= 1.0 else confidence, 1)

    if profile is not None:
        display_name = profile["display_name"]
        category = profile["category"]
        suitability = profile["grasp_suitability"]
        suggested_grip = profile["suggested_grip"]
        recommendation = profile["recommendation"]
        notes = profile["notes"]
    else:
        # Fallback for general unmapped COCO objects
        display_name = clean_label.capitalize()
        category = "General Object"
        suitability = "Requires geometric evaluation"
        suggested_grip = "Adaptive Enclosing Grip"
        recommendation = "Requires Evaluation"
        notes = "Preliminary heuristic. Further 3D or tactile assessment required."

    # Compute bounding box aspect ratio and spatial hints if available
    aspect_ratio = None
    relative_size = None
    if bbox and len(bbox) == 4:
        x1, y1, x2, y2 = bbox
        width = max(1, x2 - x1)
        height = max(1, y2 - y1)
        aspect_ratio = round(height / width, 2)
        if aspect_ratio > 1.8:
            spatial_shape = "Tall / Vertical"
        elif aspect_ratio < 0.55:
            spatial_shape = "Wide / Horizontal"
        else:
            spatial_shape = "Compact / Square"
    else:
        spatial_shape = "Unknown"

    return {
        "object_name": display_name,
        "raw_label": clean_label,
        "confidence": confidence_pct,
        "confidence_level": confidence_tier,
        "category": category,
        "potential_grasp_suitability": suitability,
        "suggested_grip": suggested_grip,
        "recommendation": recommendation,
        "spatial_shape": spatial_shape,
        "aspect_ratio": aspect_ratio,
        "notes": notes,
        "disclaimer": "Preliminary rule-based assessment based on visual category. Physical weight, center of mass, rigidity, and surface friction are not measured from 2D webcam image."
    }



OBJECT_SERVO_ANGLES = {
    "bottle": [92, 88, 90, 91, 89],
    "cup": [86, 82, 84, 85, 80],
    "wine glass": [50, 45, 45, 30, 30],
    "cell phone": [70, 65, 60, 45, 40],
    "mobile phone": [70, 65, 60, 45, 40],
    "apple": [95, 95, 95, 95, 95],
    "orange": [95, 95, 95, 95, 95],
    "banana": [88, 85, 85, 80, 75],
    "scissors": [60, 55, 50, 40, 30],
    "book": [75, 70, 70, 65, 60],
    "mouse": [80, 75, 75, 70, 70],
    "pen": [45, 45, 30, 0, 0],
    "remote": [80, 75, 75, 70, 65],
    "toothbrush": [50, 45, 35, 20, 20],
    "laptop": [90, 90, 90, 90, 90],
}


def calculate_servo_angles(label="", category=""):
    clean_label = (label or "").strip().lower()
    angles = OBJECT_SERVO_ANGLES.get(clean_label)
    if not angles:
        cat = (category or "").lower()
        if "cylindrical" in cat or "container" in cat:
            angles = [92, 88, 90, 91, 89]
        elif "spherical" in cat or "fruit" in cat:
            angles = [95, 95, 95, 95, 95]
        elif "flat" in cat or "device" in cat:
            angles = [70, 65, 60, 45, 40]
        elif "pinch" in cat or "slender" in cat or "tool" in cat:
            angles = [55, 50, 40, 25, 20]
        else:
            angles = [90, 90, 90, 90, 90]

    return {
        "success": True,
        "object": label,
        "angles": angles,
        "thumb": angles[0],
        "index": angles[1],
        "middle": angles[2],
        "ring": angles[3],
        "little": angles[4]
    }
