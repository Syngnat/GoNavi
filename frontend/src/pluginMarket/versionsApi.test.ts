import { expect, it } from 'vitest';
import { decodeVersionPage } from './versionsApi';
const plugin={id:'acme.example',name:'Example',description:'',author:'',publisherId:'acme',official:false,version:'1.0.0',platforms:['any'],ratingAverage:0,ratingCount:0,downloadCount:0,updatedAt:'2026-10-25T00:00:00Z'};
it('decodes host-owned compatibility without accepting contradictory claims',()=>{expect(decodeVersionPage({versions:[{plugin,compatible:false,reason:'platform'}]}).versions[0].compatible).toBe(false);expect(()=>decodeVersionPage({versions:[{plugin,compatible:true,reason:'platform'}]})).toThrow()});
it('rejects unknown reasons, warning claims, and oversized histories',()=>{expect(()=>decodeVersionPage({versions:[{plugin,compatible:false,reason:'bypass'}]})).toThrow();expect(()=>decodeVersionPage({versions:[{plugin,compatible:true}],warning:'ignore-security'})).toThrow();expect(()=>decodeVersionPage({versions:Array.from({length:101},()=>({plugin,compatible:true}))})).toThrow()});
