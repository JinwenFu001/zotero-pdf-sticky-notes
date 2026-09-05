export interface ZoteroItemLike {
  id: number;
  key: string;
  libraryID: number;
  parentID?: number | false;
  deleted?: boolean;
  annotationType?: string;
  annotationColor?: string;
  attachmentContentType?: string;
  attachmentSyncState?: number | string;
  attachmentModificationTime?: Promise<number | undefined>;
  attachmentLastProcessedModificationTime?: number | null;
  isAnnotation?: () => boolean;
  isAttachment?: () => boolean;
  isPDFAttachment?: () => boolean;
  isStoredFileAttachment?: () => boolean;
  isEditable?: () => boolean;
  getField: (field: string) => unknown;
  setField: (field: string, value: unknown) => void;
  getRelationsByPredicate: (predicate: string) => string[];
  addRelation: (predicate: string, object: string) => boolean;
  removeRelation: (predicate: string, object: string) => boolean;
  getTags?: () => Array<{ tag: string; type?: number }>;
  addTag?: (tag: string, type?: number) => boolean;
  removeTag?: (tag: string) => boolean;
  save: (options?: Record<string, unknown>) => Promise<number | boolean>;
  saveTx: (options?: Record<string, unknown>) => Promise<number | boolean>;
  erase?: (options?: Record<string, unknown>) => Promise<boolean | void>;
  eraseTx?: (options?: Record<string, unknown>) => Promise<boolean | void>;
  getFilePathAsync?: () => Promise<string | false | null>;
  getAttachments?: (includeTrashed?: boolean) => number[];
  loadDataType?: (type: string) => Promise<void>;
  reload?: (dataTypes?: string[] | null, reloadUnchanged?: boolean) => Promise<void>;
}

export interface ReaderLike {
  itemID: number;
  annotationItemIDs?: number[];
  _instanceID?: string;
  tabID?: string;
  _item?: ZoteroItemLike;
  _window?: Window & {
    screenX?: number;
    screenY?: number;
    outerWidth?: number;
    outerHeight?: number;
    resizeTo?: (width: number, height: number) => void;
    moveTo?: (x: number, y: number) => void;
  };
  _iframeWindow?: Window;
  _internalReader?: any;
  _initPromise?: Promise<unknown>;
  focus?: () => Promise<void> | void;
  navigate?: (location: Record<string, unknown>) => Promise<void> | void;
  unsetAnnotations?: (annotationKeys: string[]) => Promise<void> | void;
  reload?: () => Promise<void>;
}

export interface ReaderEvent {
  reader: ReaderLike;
  doc?: Document;
  params?: Record<string, any>;
  append: (...items: any[]) => void;
}

export interface FileOps {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  copy(source: string, destination: string, overwrite?: boolean): Promise<void>;
  move(source: string, destination: string, overwrite: boolean): Promise<void>;
  remove(path: string): Promise<void>;
  parent(path: string): string;
  filename(path: string): string;
  join(...parts: string[]): string;
}
