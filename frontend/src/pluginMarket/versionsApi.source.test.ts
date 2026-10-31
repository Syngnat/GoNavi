import { beforeEach, expect, it, vi } from 'vitest';
const host=vi.hoisted(()=>({PluginMarketVersions:vi.fn(),PluginMarketSourceVersions:vi.fn()}));vi.mock('../../wailsjs/go/app/App',()=>host);
import { loadMarketVersions } from './versionsApi';
const source='a'.repeat(64);const plugin={id:'acme.example',name:'Example',description:'',author:'',publisherId:'acme',official:false,version:'1.0.0',platforms:['any'],ratingAverage:0,ratingCount:0,downloadCount:0,updatedAt:'now',sourceId:source};
beforeEach(()=>{vi.resetAllMocks()});
it('requests version history only from the explicitly selected source',async()=>{host.PluginMarketSourceVersions.mockResolvedValue({success:true,data:{versions:[{plugin,compatible:true}]}});await loadMarketVersions(plugin.id,source,true);expect(host.PluginMarketSourceVersions).toHaveBeenCalledWith(source,plugin.id);expect(host.PluginMarketVersions).not.toHaveBeenCalled()});
it.each(['identity','source','duplicate'])('rejects unsafe version history: %s',async(mode)=>{const row={plugin:{...plugin,...(mode==='identity'?{id:'other.example'}:mode==='source'?{sourceId:'b'.repeat(64)}:{})},compatible:true};host.PluginMarketSourceVersions.mockResolvedValue({success:true,data:{versions:mode==='duplicate'?[row,row]:[row]}});await expect(loadMarketVersions(plugin.id,source,true)).rejects.toMatchObject({key:'plugin.error.invalid_response'})});
