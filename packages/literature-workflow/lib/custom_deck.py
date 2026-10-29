"""Render agent-authored, evidence-backed slide plans using the existing deck kit."""
import html
import inspect
import re


def normal(value):
    import unicodedata
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(value or '')))


def render(plan, record, pages, deckkit):
    slides=plan.get('slides') if isinstance(plan,dict) else None
    if not isinstance(slides,list) or not 1<=len(slides)<=100:
        raise ValueError('自定义演示必须包含1到100页')
    theme=plan.get('theme','blue');ratio=plan.get('ratio','16:9')
    if theme not in ('blue','ink','teal','warm') or ratio not in ('16:9','4:3'):
        raise ValueError('自定义演示主题或比例无效')
    known=list(record.get('evidence') or [])
    for claim in record.get('claims') or []:
        known.extend(claim.get('evidence') or [])
    title=(record.get('meta') or {}).get('title') or record.get('title') or '文献汇报'
    deck=deckkit.Deck(title=title,theme=theme,ratio=ratio,footer='依据原文证据 · 自定义阶段编排')
    for slide in slides:
        if not isinstance(slide,dict) or not isinstance(slide.get('title'),str) or not slide['title'].strip():
            raise ValueError('自定义演示每页必须有标题')
        evidence=slide.get('evidence')
        if not isinstance(evidence,list) or not evidence:
            raise ValueError('自定义演示每页必须附原文证据')
        for item in evidence:
            if not isinstance(item,dict) or not isinstance(item.get('page'),int) or item['page']<1 or len(normal(item.get('quote')))<10:
                raise ValueError('自定义演示引文格式错误')
            page=pages.get(item['page']) if pages else None
            verified=(normal(item['quote']) in normal(page)) if page else any(
                str(old.get('page'))==str(item['page']) and normal(old.get('quote'))==normal(item['quote']) for old in known)
            if not verified:
                raise ValueError('自定义演示引文未在原文或已有抽取证据中命中')
        args={}
        for field in ('title','tag','subtitle','notes','example','takeaway','transition','formula_label'):
            if slide.get(field) is not None:
                if not isinstance(slide[field],str):raise ValueError('页面文本格式错误')
                args[field]=slide[field]
        bullets=slide.get('bullets') or []
        if not isinstance(bullets,list) or any(not isinstance(value,str) for value in bullets):raise ValueError('要点必须是文本数组')
        args['bullets']=bullets
        if slide.get('formula'):
            if not isinstance(slide['formula'],str):raise ValueError('公式必须是文本')
            args['formula']=html.escape(slide['formula'])
        for field in ('vars','kv'):
            values=slide.get(field) or []
            if not isinstance(values,list) or any(not isinstance(value,list) or len(value)!=2 or any(not isinstance(v,str) for v in value) for value in values):
                raise ValueError('变量或定义卡格式错误')
            args[field]=values
        table=slide.get('table')
        if table:
            if not isinstance(table,dict) or not isinstance(table.get('headers'),list) or not isinstance(table.get('rows'),list):raise ValueError('页面表格格式错误')
            if any(not isinstance(x,str) for x in table['headers']) or any(not isinstance(row,list) or len(row)!=len(table['headers']) or any(not isinstance(x,str) for x in row) for row in table['rows']):raise ValueError('页面表格单元格必须是文本')
            args['table']={'headers':table['headers'],'rows':table['rows'],'caption':str(table.get('caption') or '')}
        cols=slide.get('cols',1)
        if cols not in (1,2,3):raise ValueError('布局列数必须是1、2或3')
        # Deck kits differ between workflow versions: pass `cols` only when the
        # installed deckkit accepts it, instead of crashing on an older API.
        try:
            supported=set(inspect.signature(deck.slide).parameters)
        except (TypeError,ValueError):
            supported=set()
        if 'cols' in supported:
            args['cols']=cols
        unit='Markdown段' if (record.get('meta') or {}).get('citation_unit')=='segment' else 'p.'
        args['footnote']='；'.join(f"{unit}{item['page']} · {item.get('field','')} · {item['quote']}" for item in evidence)
        deck.slide(**args)
    return deck.render()
