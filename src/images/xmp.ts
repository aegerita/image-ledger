import { DOMParser, onErrorStopParsing, XMLSerializer, type Element } from '@xmldom/xmldom';

const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const dc = 'http://purl.org/dc/elements/1.1/';
const xml = 'http://www.w3.org/XML/1998/namespace';
const xmlns = 'http://www.w3.org/2000/xmlns/';
const xmpNote = 'http://ns.adobe.com/xmp/note/';
const adobe = 'adobe:ns:meta/';
const name = (uri: string | null, local: string) => `{${uri ?? ''}}${local}`;
const about = name(rdf, 'about');
const rdfId = name(rdf, 'ID');
const nodeId = name(rdf, 'nodeID');
const language = name(xml, 'lang');
const description = name(dc, 'description');
const extensionRef = name(xmpNote, 'HasExtendedXMP');

type Attribute = [string, string];
interface XmpNode {
  key: string;
  attributes: Attribute[];
  content: Array<string | XmpNode>;
}

function invalidXmp(): never {
  throw new Error('Image Ledger could not verify the embedded XMP metadata.');
}

function elements(node: XmpNode): XmpNode[] {
  const children: XmpNode[] = [];
  for (const child of node.content) {
    if (typeof child !== 'string') children.push(child);
    else if (child.trim()) invalidXmp();
  }
  return children;
}

function readElement(element: Element, depth = 0): XmpNode {
  if (depth >= 128) invalidXmp();
  const attributes: Attribute[] = [];
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.namespaceURI !== xmlns) {
      attributes.push([name(attribute.namespaceURI, attribute.localName ?? attribute.name), attribute.value]);
    }
  }
  attributes.sort(([a], [b]) => a < b ? -1 : Number(a !== b));
  const content: XmpNode['content'] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 1) {
      content.push(readElement(child as Element, depth + 1));
    } else if (child.nodeType === 3 || child.nodeType === 4) {
      const value = child.nodeValue ?? '';
      const last = content.at(-1);
      if (typeof last === 'string') content[content.length - 1] = last + value;
      else if (value) content.push(value);
    }
  }
  return {key: name(element.namespaceURI, element.localName ?? element.tagName), attributes, content};
}

function readPacket(bytes: Uint8Array): Element {
  if (bytes.length > 8 * 1024 * 1024) invalidXmp();
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try {
    const text = new TextDecoder(encoding, {fatal: true}).decode(bytes);
    if (text.includes('<!DOCTYPE')) invalidXmp();
    const document = new DOMParser({onError: onErrorStopParsing}).parseFromString(text, 'application/xml');
    if (!document.documentElement) invalidXmp();
    return document.documentElement;
  } catch {
    return invalidXmp();
  }
}

function parsePacket(bytes: Uint8Array): XmpNode {
  const root = readElement(readPacket(bytes));
  if (root.key === name(rdf, 'RDF')) return root;
  if (root.key !== name(adobe, 'xmpmeta') && root.key !== name(adobe, 'xapmeta')) invalidXmp();
  const children = elements(root);
  if (children.length !== 1 || children[0].key !== name(rdf, 'RDF')) invalidXmp();
  const [graph] = children;
  const wrapper = root.attributes.filter(([key]) => key !== name(adobe, 'xmptk'));
  return {...graph, attributes: [...wrapper, ...graph.attributes]};
}

function childrenNamed(parent: Element, namespace: string, local: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(namespace, local)).filter(child => child.parentNode === parent);
}

export function replaceDefaultXmpDescription(packet: Uint8Array, caption: string): string | undefined {
  // This fallback writes a single UTF-8 packet. The regular writer handles other encodings and extended packets.
  if (packet[0] === 0xff || packet[0] === 0xfe) return;
  const root = readPacket(packet);
  const document = root.ownerDocument;
  const graph = root.namespaceURI === rdf ? root : childrenNamed(root, rdf, 'RDF')[0];
  if (!document || !graph || graph.getElementsByTagNameNS(xmpNote, 'HasExtendedXMP').length) return;
  const graphLanguage = graph.getAttributeNS(xml, 'lang') ?? root.getAttributeNS(xml, 'lang');
  const subjects = childrenNamed(graph, rdf, 'Description').filter(subject => {
    const lang = subject.getAttributeNS(xml, 'lang') ?? graphLanguage;
    return !subject.getAttributeNS(rdf, 'about') && !subject.hasAttributeNS(rdf, 'ID')
      && !subject.hasAttributeNS(rdf, 'nodeID') && (!lang || lang === 'x-default');
  });
  if (!subjects.length) return;
  const properties = subjects.flatMap(subject => childrenNamed(subject, dc, 'description'));
  const attributes = subjects.filter(subject => subject.hasAttributeNS(dc, 'description'));
  if (properties.length + attributes.length > 1) return;
  const [attribute] = attributes;
  attribute?.removeAttributeNS(dc, 'description');

  const property = properties.at(0);
  let alt = property && childrenNamed(property, rdf, 'Alt')[0];
  if (property && alt) {
    const defaults = childrenNamed(alt, rdf, 'li').filter(item => item.getAttributeNS(xml, 'lang') === 'x-default');
    for (const item of defaults) alt.removeChild(item);
    if (!caption && !childrenNamed(alt, rdf, 'li').length) property.parentNode?.removeChild(property);
  } else if (property) {
    property.parentNode?.removeChild(property);
  }

  if (caption) {
    if (!alt) {
      const created = document.createElementNS(dc, 'dc:description');
      alt = document.createElementNS(rdf, 'rdf:Alt');
      created.appendChild(alt);
      subjects[0].appendChild(created);
    }
    const item = document.createElementNS(rdf, 'rdf:li');
    item.setAttributeNS(xml, 'xml:lang', 'x-default');
    item.appendChild(document.createTextNode(caption));
    alt.insertBefore(item, alt.firstChild);
  }
  const contents = new XMLSerializer().serializeToString(root);
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${contents}\n<?xpacket end="w"?>`;
}

function withoutCaption(property: XmpNode): XmpNode | undefined {
  if (property.attributes.length) return property;
  if (property.content.every(child => typeof child === 'string')) return undefined;
  const children = elements(property);
  const [alt] = children;
  if (children.length !== 1 || alt.key !== name(rdf, 'Alt') || alt.attributes.length) return property;
  const items = elements(alt);
  const remaining = items.filter(item => item.key !== name(rdf, 'li')
    || item.attributes.length !== 1
    || item.attributes[0][0] !== language
    || item.attributes[0][1] !== 'x-default'
    || item.content.some(child => typeof child !== 'string'));
  if (items.length === remaining.length) return property;
  if (items.length - remaining.length > 1) invalidXmp();
  if (!remaining.length) return undefined;
  return {...property, content: [{...alt, content: remaining}]};
}

function canonicalNode(node: XmpNode): unknown {
  const hasElements = node.content.some(child => typeof child !== 'string');
  const onlyIndentation = node.content.every(child => typeof child !== 'string' || !child.trim());
  const content = node.content.flatMap(child => {
    if (typeof child !== 'string') return [canonicalNode(child)];
    return hasElements && onlyIndentation ? [] : [child];
  });
  return [node.key, node.attributes, content];
}

// XMP writers can change prefixes, packet padding, and how properties are grouped.
export async function canonicalXmp(packets: Uint8Array[], expectedExtendedGuid?: string): Promise<string> {
  const properties: string[] = [];
  const graphs = packets.map(packet => {
    const root = parsePacket(packet);
    return {root, subjects: elements(root)};
  });
  const subjects = new Set<string>();
  for (const graph of graphs) {
    for (const subject of graph.subjects) {
      if (subject.key === name(rdf, 'Description')) {
        const object = subject.attributes.find(([key]) => key === about || key === rdfId || key === nodeId);
        subjects.add(JSON.stringify(object ?? [about, '']));
      }
    }
  }
  let linked = false;
  let removedCaption = false;
  for (const [index, {root, subjects: graphSubjects}] of graphs.entries()) {
    for (const subject of graphSubjects) {
      if (subject.key !== name(rdf, 'Description')) {
        properties.push(JSON.stringify([root.attributes, canonicalNode(subject)]));
        continue;
      }
      const context = subject.attributes.filter(([key]) => key === about
        || key.startsWith(`{${rdf}}`) || key.startsWith(`{${xml}}`));
      const props = elements(subject);
      for (const [key, value] of subject.attributes) {
        if (!context.some(([attribute]) => attribute === key)) {
          props.push({key, attributes: [], content: value ? [value] : []});
        }
      }
      const subjectUri = context.find(([key]) => key === about)?.[1];
      const namedNode = context.some(([key]) => key === rdfId || key === nodeId);
      const mainSubject = !namedNode && (!subjectUri || subjects.size === 1);
      const subjectLanguage = (context.find(([key]) => key === language) ?? root.attributes.find(([key]) => key === language))?.[1];
      for (let property of props) {
        if (property.key === extensionRef) {
          if (index !== 0 || linked || !expectedExtendedGuid || property.attributes.length
            || property.content.length !== 1 || typeof property.content[0] !== 'string'
            || property.content[0].toUpperCase() !== expectedExtendedGuid.toUpperCase()) invalidXmp();
          linked = true;
          continue;
        }
        if (mainSubject && property.key === description && (!subjectLanguage || subjectLanguage === 'x-default')) {
          const rest = withoutCaption(property);
          if (rest !== property) {
            if (removedCaption) invalidXmp();
            removedCaption = true;
          }
          if (!rest) continue;
          property = rest;
        }
        properties.push(JSON.stringify([root.attributes, context.filter(([key, value]) => key !== about || value), canonicalNode(property)]));
      }
    }
  }
  if (expectedExtendedGuid && !linked) invalidXmp();
  return JSON.stringify(properties.sort());
}
