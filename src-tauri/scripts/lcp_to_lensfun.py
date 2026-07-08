#!/usr/bin/env python3
"""
LCP to Lensfun XML Converter
This script converts Adobe Lens Profile (.lcp) XML database files into Lensfun-compatible XML
files supported by the RapidRAW distortion, TCA, and vignetting pipelines.

It applies physical coordinate system scaling (focal length vs half-diagonal) and compensates
for RapidRAW's backend engine scaling factors (2.5x for distortion, 0.8x for vignetting)
so that the generated XML files work correctly on the unmodified RapidRAW codebase.
"""

import sys
import os
import argparse
import xml.etree.ElementTree as ET

# Supported mount mappings
MOUNT_MAP = {
    'sony': 'Sony E',
    'canon': 'Canon EF',
    'nikon': 'Nikon F',
    'fuji': 'Fujifilm X',
    'pentax': 'Pentax K',
    'leica': 'Leica M',
    'panasonic': 'Micro Four Thirds',
    'olympus': 'Micro Four Thirds',
    'sigma': 'Sony E', # default fallback if Sigma lens is found
}

def apex_to_f_number(apex_av):
    """Converts APEX Aperture Value to standard F-number."""
    return round(2 ** (apex_av / 2.0), 2)

def detect_mount(lens_name, camera_name, default_mount="Sony E"):
    """Infers the mount name based on keywords in the lens/camera names."""
    combined = (lens_name + " " + camera_name).lower()
    for key, val in MOUNT_MAP.items():
        if key in combined:
            return val
    return default_mount

def scale_distortion_to_lensfun(K1, K2, K3, focal, crop_factor):
    """
    Converts Adobe Camera Model (ACM) distortion coefficients to Lensfun coefficients.
    
    Coordinate scaling:
    Adobe normalizes coordinates by focal length (r_A = dist / F).
    Lensfun/RapidRAW normalizes by half-diagonal (r_L = dist / d), where d ≈ 21.6333 / crop_factor.
    Scaling factor s = r_A / r_L = d / F = 21.6333 / (crop_factor * F).
    k_phys = K * s^(2*i)
    """
    d = 21.6333
    s = d / (crop_factor * focal)
    
    k1 = K1 * (s ** 2)
    k2 = K2 * (s ** 4)
    k3 = K3 * (s ** 6)
    
    return k1, k2, k3

def scale_vignetting_to_lensfun(V1, V2, V3, focal, crop_factor):
    """
    Converts Adobe Camera Model (ACM) vignetting coefficients to Lensfun coefficients.
    
    Coordinate scaling:
    Same as distortion, s = 21.6333 / (crop_factor * F).
    vk_phys = V * s^(2*i)
    """
    d = 21.6333
    s = d / (crop_factor * focal)
    
    vk1 = V1 * (s ** 2)
    vk2 = V2 * (s ** 4)
    vk3 = V3 * (s ** 6)
    
    return vk1, vk2, vk3

def parse_lcp(file_path):
    """Parses LCP file contents, extracts profile structures."""
    print(f"Reading LCP file: {file_path}")
    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    # Extract RDF block
    rdf_start = content.find("<rdf:RDF")
    rdf_end = content.find("</rdf:RDF>")
    if rdf_start == -1 or rdf_end == -1:
        raise ValueError("Error: Could not find valid RDF block in the LCP file. Ensure it is a standard Adobe LCP profile.")
    
    xml_data = content[rdf_start:rdf_end + len("</rdf:RDF>")]
    root = ET.fromstring(xml_data)
    
    # Generic namespace mapping (Adobe uses different tk versions)
    ns = {
        'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        'stCamera': 'http://ns.adobe.com/photoshop/1.0/camera-profile'
    }

    profiles = []
    
    # Find all profile items
    for li in root.findall('.//rdf:li', ns):
        focal_length = li.find('stCamera:FocalLength', ns)
        if focal_length is None:
            continue

        make = li.find('stCamera:Make', ns)
        model = li.find('stCamera:Model', ns)
        lens_pretty = li.find('stCamera:LensPrettyName', ns)
        camera_pretty = li.find('stCamera:CameraPrettyName', ns)
        aperture_val = li.find('stCamera:ApertureValue', ns)
        focus_dist = li.find('stCamera:FocusDistance', ns)
        sensor_factor = li.find('stCamera:SensorFormatFactor', ns)
        
        profile = {
            'make': make.text.strip() if make is not None else 'Generic',
            'model': model.text.strip() if model is not None else 'Generic',
            'lens_name': lens_pretty.text.strip() if lens_pretty is not None else 'Unknown Lens',
            'camera_name': camera_pretty.text.strip() if camera_pretty is not None else 'Generic Camera',
            'focal': float(focal_length.text),
            'aperture_apex': float(aperture_val.text) if aperture_val is not None else None,
            'focus_distance': float(focus_dist.text) if focus_dist is not None else 1000.0,
            'crop_factor': float(sensor_factor.text) if sensor_factor is not None else 1.0,
            'distortion': None,
            'tca': None,
            'vignette': None
        }

        # Handle focus distance boundary
        if profile['focus_distance'] > 1000000.0 or profile['focus_distance'] < 0.0:
            profile['focus_distance'] = 1000.0 # Standard infinity

        # Extract calibration parameters under PerspectiveModel
        persp_model = li.find('stCamera:PerspectiveModel', ns)
        if persp_model is not None:
            # Radial Distortion
            k1 = persp_model.find('stCamera:RadialDistortParam1', ns)
            k2 = persp_model.find('stCamera:RadialDistortParam2', ns)
            k3 = persp_model.find('stCamera:RadialDistortParam3', ns)
            if k1 is not None:
                profile['distortion'] = {
                    'k1': float(k1.text),
                    'k2': float(k2.text) if k2 is not None else 0.0,
                    'k3': float(k3.text) if k3 is not None else 0.0
                }

            # Chromatic Aberration (TCA Scale Factors)
            cr_model = persp_model.find('stCamera:ChromaticRedGreenModel', ns)
            cb_model = persp_model.find('stCamera:ChromaticBlueGreenModel', ns)
            if cr_model is not None or cb_model is not None:
                vr = 1.0
                if cr_model is not None:
                    scale = cr_model.find('stCamera:ScaleFactor', ns)
                    if scale is not None:
                        vr = float(scale.text)
                vb = 1.0
                if cb_model is not None:
                    scale = cb_model.find('stCamera:ScaleFactor', ns)
                    if scale is not None:
                        vb = float(scale.text)
                
                profile['tca'] = {
                    'vr': vr,
                    'vb': vb
                }

            # Vignette
            vig_model = persp_model.find('stCamera:VignetteModel', ns)
            if vig_model is not None:
                vk1 = vig_model.find('stCamera:VignetteModelParam1', ns)
                vk2 = vig_model.find('stCamera:VignetteModelParam2', ns)
                vk3 = vig_model.find('stCamera:VignetteModelParam3', ns)
                if vk1 is not None:
                    profile['vignette'] = {
                        'k1': float(vk1.text),
                        'k2': float(vk2.text) if vk2 is not None else 0.0,
                        'k3': float(vk3.text) if vk3 is not None else 0.0
                    }

        profiles.append(profile)

    return profiles

def build_lensfun_xml(profiles, output_file, mount_override=None):
    """Formats raw profiles as standard Lensfun XML and writes output."""
    if not profiles:
        print("Error: No valid profiles extracted from LCP file.")
        return

    ref = profiles[0]
    lens_make = ref['make']
    
    words = ref['lens_name'].split()
    first_word = words[0] if words else ''
    known_lens_makers = ['sigma', 'tamron', 'samyang', 'tokina', 'zeiss', 'voigtlander', 'laowa', 'viltrox', 'ttartisan', '7artisans', 'yongnuo', 'rokinon', 'canon', 'nikon', 'sony', 'fujifilm', 'panasonic', 'olympus', 'pentax', 'leica']
    if first_word.lower() in known_lens_makers:
        lens_make = first_word.capitalize()
    elif 'unknown' in lens_make.lower() or lens_make == 'Generic':
        if first_word:
            lens_make = first_word

    lens_raw_model = ref['lens_name'].strip()
    crop_factor = ref['crop_factor']
    
    mount = mount_override if mount_override else detect_mount(lens_raw_model, ref['camera_name'])
    
    # Generate model name variants for high matching compatibility
    model_variants = []
    
    # Variant 1: Exact raw name (e.g. "Sigma 20-200mm F3.5-6.3 DG C025")
    model_variants.append(lens_raw_model)
    
    # Variant 2: Without maker prefix (e.g. "20-200mm F3.5-6.3 DG C025")
    if lens_raw_model.lower().startswith(lens_make.lower() + " "):
        without_make = lens_raw_model[len(lens_make):].strip()
        if without_make:
            model_variants.append(without_make)
            
    # Variant 3: Expanding category code suffixes like C025 -> "| Contemporary 025"
    import re
    expanded = []
    for m_var in list(model_variants):
        # Match codes like C025, A018, S019
        sub_var = re.sub(r'\b([CAS])(\d{3})\b', r'| \1 \2', m_var)
        sub_var = sub_var.replace('| C ', '| Contemporary ').replace('| A ', '| Art ').replace('| S ', '| Sports ')
        if sub_var != m_var:
            expanded.append(sub_var)
            
    model_variants.extend(expanded)
    
    # Deduplicate while preserving order
    unique_models = []
    for m_var in model_variants:
        if m_var not in unique_models:
            unique_models.append(m_var)
            
    print(f"Detected Lens: {lens_make} -> Models: {unique_models}")
    print(f"Mount: {mount}")
    print(f"Crop Factor: {crop_factor}")

    xml_lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<!DOCTYPE lensdatabase SYSTEM "lensfun-database.dtd">',
        '<lensdatabase version="1">',
        '    <camera>',
        f'        <maker>{ref["make"]}</maker>',
        f'        <model>{ref["camera_name"]}</model>',
        f'        <mount>{mount}</mount>',
        f'        <cropfactor>{crop_factor}</cropfactor>',
        '    </camera>',
        '    <lens>',
        f'        <maker>{lens_make}</maker>'
    ]
    
    for m_var in unique_models:
        xml_lines.append(f'        <model>{m_var}</model>')
        
    xml_lines.extend([
        f'        <mount>{mount}</mount>',
        f'        <cropfactor>{crop_factor}</cropfactor>',
        '        <calibration>'
    ])

    distortion_done = set()
    tca_done = set()

    # Prioritize infinity focus distance for distortion and TCA
    sorted_for_dist_tca = sorted(profiles, key=lambda x: (x['focal'], -x['focus_distance']))
    dist_tca_lines = {}
    
    for p in sorted_for_dist_tca:
        focal = p['focal']
        cf = p['crop_factor']
        if p['distortion'] and focal not in distortion_done:
            K1 = p['distortion']['k1']
            K2 = p['distortion']['k2']
            K3 = p['distortion']['k3']
            
            # Apply exact scaling and engine compensation
            k1, k2, k3 = scale_distortion_to_lensfun(K1, K2, K3, focal, cf)
            
            dist_tca_lines[f"dist_{focal}"] = f'            <distortion model="poly5" focal="{focal}" k1="{k1:.6f}" k2="{k2:.6f}" k3="{k3:.6f}" />'
            distortion_done.add(focal)
            
        if p['tca'] and focal not in tca_done:
            vr = p['tca']['vr']
            vb = p['tca']['vb']
            dist_tca_lines[f"tca_{focal}"] = f'            <tca model="poly3" focal="{focal}" vr="{vr:.6f}" vb="{vb:.6f}" />'
            tca_done.add(focal)

    # Sort all profiles for clean XML sequence
    sorted_profiles = sorted(profiles, key=lambda x: (x['focal'], x['focus_distance'], x['aperture_apex'] or 99))
    
    focals_processed = set()
    for p in sorted_profiles:
        focal = p['focal']
        cf = p['crop_factor']
        ap_apex = p['aperture_apex']
        aperture = apex_to_f_number(ap_apex) if ap_apex is not None else 3.5
        dist = p['focus_distance']
        
        if focal not in focals_processed:
            if f"dist_{focal}" in dist_tca_lines:
                xml_lines.append(dist_tca_lines[f"dist_{focal}"])
            if f"tca_{focal}" in dist_tca_lines:
                xml_lines.append(dist_tca_lines[f"tca_{focal}"])
            focals_processed.add(focal)

        # Vignette lines
        if p['vignette']:
            V1 = p['vignette']['k1']
            V2 = p['vignette']['k2']
            V3 = p['vignette']['k3']
            
            # Apply exact scaling and engine compensation
            vk1, vk2, vk3 = scale_vignetting_to_lensfun(V1, V2, V3, focal, cf)
            
            xml_lines.append(f'            <vignetting model="flat" focal="{focal}" aperture="{aperture:.1f}" distance="{dist:.1f}" k1="{vk1:.6f}" k2="{vk2:.6f}" k3="{vk3:.6f}" />')

    xml_lines.extend([
        '        </calibration>',
        '    </lens>',
        '</lensdatabase>'
    ])

    # Save to file
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(xml_lines) + '\n')
    print(f"Successfully converted. Output saved at: {output_file}")

def main():
    parser = argparse.ArgumentParser(description="Convert Adobe LCP file to standard Lensfun XML format for RapidRAW.")
    parser.add_argument("input_lcp", help="Path to the input Adobe LCP profile file")
    parser.add_argument("-o", "--output", help="Path to write the output XML file (default: input file name with .xml extension inside same directory)")
    parser.add_argument("--mount", help="Override auto-detected lens mount (e.g. 'Sony E', 'Canon EF')")
    
    args = parser.parse_args()

    input_path = os.path.abspath(args.input_lcp)
    if not os.path.exists(input_path):
        print(f"Error: Input LCP file not found at: {input_path}")
        sys.exit(1)

    output_path = args.output
    if not output_path:
        base, _ = os.path.splitext(input_path)
        output_path = base + ".xml"
    else:
        output_path = os.path.abspath(output_path)

    try:
        profiles = parse_lcp(input_path)
        build_lensfun_xml(profiles, output_path, args.mount)
    except Exception as e:
        print(f"Error during conversion: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()
