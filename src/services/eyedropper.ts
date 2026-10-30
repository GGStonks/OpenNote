/**
 * The colour pickers' eyedropper: "take a colour from the page". The editor registers how to read
 * the colour under a tap (Editor.tsx colourAt); a picker asks for one tap and gets its colour
 * (null: cancelled, or no editor open).
 */
type Picker = () => Promise<string | null>;

let picker: Picker | null = null;
const listeners = new Set<() => void>();

export function setColourPicker(p: Picker | null) {
  picker = p;
  listeners.forEach((fn) => fn());
}

export function canPickColour(): boolean {
  return !!picker;
}

export function pickColour(): Promise<string | null> {
  return picker ? picker() : Promise.resolve(null);
}

export function onColourPickerChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
