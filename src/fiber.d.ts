// Keep an eye on https://github.com/Microsoft/TypeScript/pull/30790
//  would like to remove the <any> and infer from iterator's explicit return type
export const fiber: <T = any>(iterator: IterableIterator<any>) => Posterus.Future<T>;