/*
 * The glyph in front of a room's name, by the room type the robot keeps as a tag (LocalRock's
 * RoomIcons.kt): Material icon paths on a 24-unit grid, drawn on the map canvas.
 */
const BED = 'M21 10.78V8c0-1.65-1.35-3-3-3h-4c-.77 0-1.47.3-2 .78-.53-.48-1.23-.78-2-.78H6C4.35 5 3 6.35 3 8v2.78c-.61.55-1 1.34-1 2.22v6h2v-2h16v2h2v-6c0-.88-.39-1.67-1-2.22zM14 7h4c.55 0 1 .45 1 1v2h-6V8c0-.55.45-1 1-1zM5 8c0-.55.45-1 1-1h4c.55 0 1 .45 1 1v2H5V8zm-1 7v-2c0-.55.45-1 1-1h14c.55 0 1 .45 1 1v2H4z';
const SOFA = 'M21 10c-1.1 0-2 .9-2 2v3H5v-3c0-1.1-.89-2-2-2s-2 .9-2 2v5c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2v-5c0-1.1-.9-2-2-2zm-3-5H6c-1.1 0-2 .9-2 2v2.15c1.16.41 2 1.51 2 2.82V14h12v-2.03c0-1.3.84-2.4 2-2.82V7c0-1.1-.9-2-2-2z';
const DINING = 'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z';
const KITCHEN = 'M18 2.01L6 2c-1.1 0-2 .89-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.11-.9-1.99-2-1.99zM18 20H6v-9.02h12V20zm0-11H6V4h12v5zM8 5h2v3H8zm0 7h2v5H8z';
const BATH = 'M7 7c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm13 6V4.83C20 3.27 18.73 2 17.17 2c-.75 0-1.47.3-2 .83l-1.25 1.25c-.16-.05-.33-.08-.51-.08-.4 0-.77.12-1.08.32l2.76 2.76c.2-.31.32-.68.32-1.08 0-.18-.03-.34-.07-.51l1.25-1.25c.15-.15.36-.24.58-.24.46 0 .83.37.83.83V13h-6.85c-.3-.21-.57-.45-.82-.72l-1.4-1.55c-.19-.21-.43-.38-.69-.5-.31-.15-.65-.23-1-.23C6 10.01 5 11.01 5 12.25V13H2v6c0 1.1.9 2 2 2 0 .55.45 1 1 1h14c.55 0 1-.45 1-1 1.1 0 2-.9 2-2v-6h-2z';
const BOOK = 'M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z';
const DOOR = 'M14 6v15H3v-2h2V3h9v1h5v15h2v2h-4V6h-3zm-4 5v2h2v-2h-2z';
const DECK = 'M22 9L12 2 2 9h9v13h2V9h9zM4.14 12l-1.96.37.82 4.37V22h2l.02-4H7v4h2v-6H4.9zm14.96 4H15v6h2v-4h1.98l.02 4h2v-5.26l.82-4.37-1.96-.37z';
const HOME = 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z';

// Tags as the robot numbers them (see ROOM_TYPES): bedrooms 1 to 3, living room 6, balcony 7,
// corridor 8, study 9, hall 10, dining room 13, kitchen 14, bathroom 15.
const BY_TAG: Record<number, string> = { 1: BED, 2: BED, 3: BED, 6: SOFA, 7: DECK, 8: DOOR, 9: BOOK, 10: DOOR, 13: DINING, 14: KITCHEN, 15: BATH };

const cache = new Map<string, Path2D>();

export function roomIconPath(tag: number | null | undefined): Path2D {
  const d = (tag != null ? BY_TAG[tag] : undefined) ?? HOME;
  let p = cache.get(d);
  if (!p) { p = new Path2D(d); cache.set(d, p); }
  return p;
}
