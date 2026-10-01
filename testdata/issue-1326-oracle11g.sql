with book  as (  -- 根据业务单元编码获取账簿id
    SELECT ab.pk_accountingbook,ab.pk_relorg,o.code,o.name
        FROM nc65.org_accountingbook ab                                     -- 账簿
        INNER join nc65.org_financeorg o on o.PK_FINANCEORG=ab.pk_relorg            -- 财务组织
        WHERE ab.dr=0
        and ab.enablestate =2            -- 启用状态：1=未启用；2=已启用；3=已停用
        and ab.accounttype =1            -- 账簿分类：1=主账簿；2=报告账簿
        and o.code in  ('${orgcode}') -- 组织编码筛选
),
	soa as  (           -- 会计科目id列表
    SELECT
        ac.pk_accasoa,kmjb.code,ac.dispname dispname
        FROM nc65.bd_accchart kmb                                              --科目表
        INNER JOIN nc65.bd_accasoa ac ON ac.pk_accchart = kmb.pk_accchart      --会计科目
        INNER JOIN nc65.bd_account kmjb ON kmjb.pk_account = ac.pk_account AND kmjb.code in ('1122','220301')    --会计科目基本信息：科目编码
        INNER join book on book.pk_relorg=kmb.pk_org                      -- 组织筛选
        WHERE kmb.dr=0
        AND ac.dr=0
        AND ac.enablestate=2
),
-- 不含：该凭证号下只有 2 个不同科目，且这两个科目为1122\220301、且客商为旅游前台
	t1 as (
select
    d.pk_voucher
FROM nc65.gl_detail  d
INNER join book on book.pk_accountingbook=d.pk_accountingbook    -- 账簿范围
LEFT JOIN nc65.gl_docfree1 f1 ON d.assid = f1.assid  -- 客商=旅游前台
WHERE 1=1
    AND d.yearv between '${yearfr}' and  '${yearto}'
    AND d.periodv >= '01'
    and d.yearv || '-' || d.periodv between '${periodfr}' and  '${periodto}'
    AND d.discardflagv <> 'Y'
    AND d.dr = 0
    AND d.voucherkindv <> 255
    AND d.tempsaveflag <> 'Y'
    AND d.voucherkindv <> 5
group by d.pk_voucher
HAVING NOT (COUNT(DISTINCT d.pk_accasoa) = 2
   AND COUNT(DISTINCT CASE WHEN d.pk_accasoa IN (select pk_accasoa from soa) and f1.F4='1001A11000000001M9CS' THEN d.pk_accasoa END) = 2
   )
	)

SELECT
    '{"o":"' || book.code || '","d":"' || NVL(TO_CHAR(TO_DATE(SUBSTR(d1.freevalue2, 1,10), 'YYYY-MM-DD'), 'YYYY-MM-DD'),'') || '","n":"' || vt.name || '","a":' || (Case when abs(d.localcreditamount)<1 then TO_CHAR(d.localcreditamount,'FM9999999990.999') else d.localcreditamount || '' end) || ',"e":"' ||
REPLACE(
        REPLACE(
            REPLACE(
                REPLACE(
                    REPLACE(
                        REPLACE(
                            REPLACE(
                                REPLACE(d.explanation, CHR(9),  ' '),
                                CHR(10), ' '),
                            CHR(13), ' '),
                        CHR(0),  ' '),
                    '"',  ' '),
                '\',  ' '),
            '&',  ' '),
        '''', ' '
    )
    || '","h":' || d.NOV || ',"r":"' || SUBSTR(d.prepareddatev, 1,7) || '","b":"' || case when v.free3='~' then '' when v.free3 is null then '' else v.free3 end || '","u":"' || u.user_name|| '"}' as jsfield
    FROM nc65.gl_detail  d                                                      -- 明细账
    inner join nc65.gl_voucher v on d.pk_voucher = v.pk_voucher -- 凭证主表
    INNER join soa  on d.pk_accasoa=soa.pk_accasoa                -- 科目代码范围
    INNER join book on book.pk_accountingbook=d.pk_accountingbook    -- 账簿范围
    INNER JOIN nc65.gl_docfree1 f1 ON d.assid = f1.assid and f1.F4='1001A11000000001M9CS'  -- 客商=旅游前台
    INNER join nc65.bd_vouchertype vt on vt.pk_vouchertype = d.pk_vouchertypev	-- 凭证类别
    INNER join nc65.sm_user u  on u.cuserid = d. pk_preparedv
    INNER join nc65.gl_dtlfreevalue d1 on d1.pk_detail = d.pk_detail
    inner join t1 on t1.pk_voucher=d.pk_voucher
    WHERE 1=1
    AND d.yearv between '${yearfr}' and  '${yearto}'
    AND d.periodv >= '01'
    and d.yearv || '-' || d.periodv between '${periodfr}' and  '${periodto}'
    and TO_CHAR(TO_DATE(SUBSTR(d1.freevalue2, 1,10), 'YYYY-MM-DD'), 'YYYY-MM-DD') between '${datefr}' and  '${dateto}'
    AND d.discardflagv <> 'Y'
    AND d.dr = 0
    AND d.voucherkindv <> 255
    AND d.tempsaveflag <> 'Y'
    AND d.voucherkindv <> 5
    and d.localcreditamount <>0
    and d1.freevalue2 is not null
    order by NVL(TO_CHAR(TO_DATE(SUBSTR(d1.freevalue2, 1,10), 'YYYY-MM-DD'), 'YYYY-MM-DD'),'')
