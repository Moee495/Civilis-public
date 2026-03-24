import type { RealtimeEvent } from './api'
import { formatDynamicNarrative } from './dynamic-text'

function asString(value: unknown, fallback = '—'): string {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function asNarrative(value: unknown, zh: boolean, fallback = '—'): string {
  const text = asString(value, fallback)
  return text === fallback ? text : formatDynamicNarrative(text, zh)
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function formatAmount(value: unknown, decimals = 3): string {
  const amount = asNumber(value)
  if (amount === null) return '—'
  return amount.toFixed(decimals).replace(/\.?0+$/, '')
}

function shortAgent(value: unknown): string {
  const text = asString(value, 'unknown')
  return text === 'treasury' ? 'treasury' : text
}

function humanizeType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function humanizeField(key: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    agentId: ['智能体', 'Agent'],
    authorId: ['作者', 'Author'],
    buyerAgentId: ['买方', 'Buyer'],
    buyerId: ['买方', 'Buyer'],
    sellerAgentId: ['卖方', 'Seller'],
    targetAgentId: ['目标', 'Target'],
    postId: ['帖子', 'Post'],
    dimension: ['维度', 'Dimension'],
    category: ['分类', 'Category'],
    count: ['数量', 'Count'],
    price: ['价格', 'Price'],
    paywallPrice: ['付费价', 'Paywall Price'],
    amount: ['金额', 'Amount'],
    tick: ['轮次', 'Tick'],
    tickNumber: ['轮次', 'Round'],
    roundNumber: ['轮次', 'Round'],
    endTick: ['结束轮次', 'End Round'],
    status: ['状态', 'Status'],
    phase: ['阶段', 'Phase'],
    ratio: ['供给系数', 'Ratio'],
    treasuryBalance: ['国库余额', 'Treasury'],
    worldRegime: ['世界阶段', 'World Regime'],
    signalCount: ['变化数量', 'Signal Count'],
    hasExternalMarket: ['外部行情', 'External Market'],
    intelType: ['情报类型', 'Intel Type'],
  }

  const pair = labels[key]
  if (pair) return zh ? pair[0] : pair[1]
  return key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()
}

function formatRuntimeValue(key: string, value: unknown, zh: boolean): string {
  if (typeof value === 'boolean') {
    return zh ? (value ? '是' : '否') : (value ? 'yes' : 'no')
  }

  const text = asString(value)
  if (text === '—') return text

  if (zh) {
    if (key === 'worldRegime' || key === 'phase') {
      const labels: Record<string, string> = {
        boom: '繁荣',
        stable: '稳定',
        recession: '衰退',
        crisis: '危机',
      }
      return labels[text] ?? formatDynamicNarrative(text, zh)
    }

    if (key === 'source') {
      const labels: Record<string, string> = {
        live: '实盘',
        mock: '回退样本',
      }
      return labels[text] ?? formatDynamicNarrative(text, zh)
    }
  }

  return typeof value === 'string' ? formatDynamicNarrative(text, zh) : text
}

function summarizePayload(payload: Record<string, unknown>, zh: boolean): string {
  const entries = Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .filter(([key]) => !['txHash', 'signature', 'proof', 'metadata'].includes(key))
    .slice(0, 4)

  if (entries.length === 0) return zh ? '无额外上下文' : 'no extra context'

  return entries
    .map(([key, value]) => {
      const rendered = formatRuntimeValue(key, value, zh)
      return `${humanizeField(key, zh)} ${rendered}`
    })
    .join(' | ')
}

function formatIntelType(type: unknown, zh: boolean): string {
  const value = asString(type, '')
  const labels: Record<string, [string, string]> = {
    arena_analysis: ['竞技场分析', 'Arena Analysis'],
    trust_map: ['信任图谱', 'Trust Map'],
    behavior_prediction: ['行为预测', 'Behavior Prediction'],
    market_signal: ['市场信号', 'Market Signal'],
  }

  const pair = labels[value]
  if (pair) return zh ? pair[0] : pair[1]
  return value || (zh ? '情报内容' : 'intel content')
}

function txTypeLabel(txType: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    register: ['注册', 'Register'],
    arena_entry: ['竞技入场', 'Arena Entry'],
    arena_entry_refund: ['入场退回', 'Arena Refund'],
    arena_action: ['竞技结算', 'Arena Payout'],
    negotiation: ['谈判消息', 'Negotiation'],
    post: ['发帖', 'Post'],
    reply: ['回复', 'Reply'],
    tip: ['打赏', 'Tip'],
    paywall: ['付费墙', 'Paywall'],
    intel_v2_purchase: ['情报购买', 'Intel Purchase'],
    intel_purchase: ['情报购买', 'Intel Purchase'],
    intel_spy: ['情报刺探', 'Intel Spy'],
    intel_self_discover: ['命格自省', 'Self Discover'],
    death_treasury: ['遗产归库', 'Treasury Share'],
    death_inheritance: ['遗产继承', 'Inheritance'],
    death_social: ['社会分配', 'Social Share'],
    economy_tax: ['反垄断税', 'Anti-monopoly Tax'],
    economy_ubi: ['UBI补贴', 'UBI'],
    economy_bailout: ['救助', 'Bailout'],
  }

  const pair = labels[txType]
  return pair ? (zh ? pair[0] : pair[1]) : txType
}

export function formatRealtimeEvent(event: RealtimeEvent, zh: boolean): { title: string; summary: string } {
  const p = event.payload ?? {}

  switch (event.type) {
    case 'x402_payment': {
      const txType = asString(p.txType, 'payment')
      return {
        title: zh ? '支付记录' : 'X402 Payment',
        summary: `${shortAgent(p.from)} → ${shortAgent(p.to)} | ${txTypeLabel(txType, zh)} | ${formatAmount(p.amount)} USDT`,
      }
    }
    case 'arena_created':
      return {
        title: zh ? '新对局创建' : 'New Match',
        summary: `${asString(p.playerAName ?? p.playerAId)} vs ${asString(p.playerBName ?? p.playerBId)} | ${asString(p.matchType, 'prisoners_dilemma')}`,
      }
    case 'arena_round_settled':
      return {
        title: zh ? '竞技场轮次结算' : 'Arena Round',
        summary: `${asString(p.playerAId)} vs ${asString(p.playerBId)} | R${asString(p.round, '?')}/${asString(p.maxRounds ?? p.totalRounds, '?')} | ${asString(p.outcome)} | A ${formatAmount(p.roundPayoutA)} / B ${formatAmount(p.roundPayoutB)}`,
      }
    case 'arena_settled':
      return {
        title: zh ? '竞技场终局结算' : 'Arena Settled',
        summary: `${asString(p.playerAId)} vs ${asString(p.playerBId)} | ${asString(p.outcome)} | A ${formatAmount(p.cumulativePayoutA ?? p.playerAPayout)} / B ${formatAmount(p.cumulativePayoutB ?? p.playerBPayout)}`,
      }
    case 'arena_decision':
      return {
        title: zh ? '决策已提交' : 'Decision Locked',
        summary: `${asString(p.agentName ?? p.agentId)} ${zh ? '已锁定本轮选择' : 'locked in a move for this round'}${p.reason ? ` | ${asNarrative(p.reason, zh)}` : ''}`,
      }
    case 'negotiation_msg':
      return {
        title: zh ? '谈判消息' : 'Negotiation',
        summary: `${asString(p.senderName ?? p.senderAgentId)} → ${asString(p.receiverName ?? p.receiverAgentId)} | ${asString(p.messageType, zh ? '普通消息' : 'message')}`,
      }
    case 'negotiation_ended':
      return {
        title: zh ? '谈判结束' : 'Negotiation Ended',
        summary: `${asString(p.playerAId)} vs ${asString(p.playerBId)} ${zh ? '进入决策阶段' : 'entered the decision phase'}`,
      }
    case 'prediction_created':
      return {
        title: zh ? '预测市场开启' : 'Prediction Open',
        summary: zh
          ? `第${asString(p.roundNumber)}轮 | ${asString(p.coinA)} 对 ${asString(p.coinB)} | 截止到第${asString(p.endTick)}轮`
          : `Round ${asString(p.roundNumber)} | ${asString(p.coinA)} vs ${asString(p.coinB)} | ends round ${asString(p.endTick)}`,
      }
    case 'prediction_settled':
      return {
        title: zh ? '预测市场结算' : 'Prediction Settled',
        summary: `Round ${asString(p.roundNumber)} | ${asString(p.coinA)} ${formatAmount(p.changeA, 2)}% vs ${asString(p.coinB)} ${formatAmount(p.changeB, 2)}% | ${zh ? '胜者' : 'winner'} ${asString(p.actualWinner)}`,
      }
    case 'intel_self_discovered':
      return {
        title: zh ? '命格内省' : 'Self Discovery',
        summary: `${asString(p.agentId)} ${zh ? '解锁了自己的' : 'unlocked'} ${asString(p.dimension, zh ? '命格维度' : 'fate dimension')}`,
      }
    case 'intel_spied':
      return {
        title: zh ? '情报窥探' : 'Intel Spy',
        summary: `${asString(p.spyAgentId)} → ${asString(p.targetAgentId)} | ${asString(p.dimension, zh ? '未知维度' : 'unknown dimension')}`,
      }
    case 'intel_listed':
      return {
        title: zh ? '情报挂牌' : 'Intel Listed',
        summary: `${asString(p.sellerAgentId)} ${zh ? '挂出' : 'listed'} ${asString(p.dimension)} | ${formatAmount(p.price)} USDT`,
      }
    case 'intel_purchased':
      return {
        title: zh ? '情报买入' : 'Intel Purchased',
        summary: `${asString(p.buyerAgentId)} ${zh ? '向' : 'bought from'} ${asString(p.sellerAgentId)} ${zh ? '买入' : ''} ${asString(p.dimension)} | ${formatAmount(p.price)} USDT`,
      }
    case 'commons_settled':
      {
        const contribute = asNumber(p.contributors) ?? 0
        const freeRide = asNumber(p.freeRiders) ?? 0
        const hoard = asNumber(p.hoarders) ?? 0
        const sabotage = asNumber(p.saboteurs) ?? 0
      return {
        title: zh ? '公共品结算' : 'Commons Settled',
        summary: `Round ${asString(p.roundNumber)} | ${zh ? '合作率' : 'co-op'} ${formatAmount(p.cooperationRate, 2)} | C${contribute} FR${freeRide} H${hoard} S${sabotage} | ${zh ? '奖池' : 'pool'} ${formatAmount(p.finalPool)} USDT`,
      }
      }
    case 'economy_regulated':
      return {
        title: zh ? '经济调控' : 'Economy Regulated',
        summary: zh
          ? `第${asString(p.tick)}轮 | 阶段 ${formatRuntimeValue('phase', p.phase, true)} | 供给系数 ${formatAmount(p.ratio, 4)} | 国库 ${formatAmount(p.treasuryBalance)} USDT`
          : `Round ${asString(p.tick)} | phase ${asString(p.phase)} | ratio ${formatAmount(p.ratio, 4)} | treasury ${formatAmount(p.treasuryBalance)} USDT`,
      }
    case 'world_event':
      return {
        title: zh ? '世界事件' : 'World Event',
        summary: `${asNarrative(p.title, zh)}${p.description ? ` — ${asNarrative(p.description, zh)}` : ''}`,
      }
    case 'new_post':
      return {
        title: zh ? '广场新帖' : 'New Post',
        summary: `${asString(p.agentId)} ${p.postType === 'farewell' ? (zh ? '发布遗言' : 'posted a farewell') : (zh ? '发布了动态' : 'posted an update')}`,
      }
    case 'new_reply':
      return {
        title: zh ? '广场回复' : 'New Reply',
        summary: `${asString(p.agentId ?? p.authorAgentId)} ${zh ? '发出了一条回复' : 'added a reply'}`,
      }
    case 'tip':
      return {
        title: zh ? '打赏' : 'Tip',
        summary: `${asString(p.fromAgentId)} → ${asString(p.toAgentId)} | ${formatAmount(p.amount)} USDT`,
      }
    case 'paywall_unlock':
      return {
        title: zh ? '付费墙解锁' : 'Paywall Unlock',
        summary: `${asString(p.buyerAgentId)} ${zh ? '解锁了付费内容' : 'unlocked premium content'}`,
      }
    case 'agent_death':
      return {
        title: zh ? '智能体离场' : 'Agent Death',
        summary: `${asString(p.agentId)} ☠️ ${asString(p.reason, zh ? '死亡' : 'died')}`,
      }
    case 'bailout':
      return {
        title: zh ? '系统救助' : 'Bailout',
        summary: `${asString(p.agentId)} ${zh ? '获得救助' : 'received a bailout'} | ${formatAmount(p.amount)} USDT`,
      }
    case 'twilight':
      return {
        title: zh ? '黄昏状态' : 'Twilight State',
        summary: `${asString(p.agentId)} ${zh ? '进入濒死黄昏' : 'entered twilight'} | ${formatAmount(p.balance)} USDT`,
      }
    case 'twilight_escaped':
      return {
        title: zh ? '逃离黄昏' : 'Escaped Twilight',
        summary: `${asString(p.agentId)} ${zh ? '暂时逃过了死亡' : 'escaped the death spiral'}`,
      }
    case 'group_panic':
      return {
        title: zh ? '群体恐慌' : 'Group Panic',
        summary: `${zh ? '群体情绪失稳' : 'Collective emotions destabilized'} | ${zh ? `第${asString(p.tick)}轮` : `Round ${asString(p.tick)}`}`,
      }
    case 'intel_v2_purchased':
      return {
        title: zh ? '情报成交' : 'Intel Purchased',
        summary: `${asString(p.buyerAgentId)} ${zh ? '购买了' : 'bought'} ${asString(p.category)} | ${formatAmount(p.price, 4)} USDT`,
      }
    case 'intel_v2_resale':
      return {
        title: zh ? '情报转售' : 'Intel Resale',
        summary: `${asString(p.sellerAgentId)} ${zh ? '挂牌转售' : 'listed for resale'} ${asString(p.category)} | ${formatAmount(p.resalePrice, 4)} USDT`,
      }
    case 'intel_posted':
      return {
        title: zh ? '情报发布' : 'Intel Posted',
        summary: `${asString(p.authorId)} ${zh ? '发布了' : 'posted'} ${formatIntelType(p.intelType, zh)}${p.paywallPrice ? ` | ${formatAmount(p.paywallPrice)} USDT` : ''}`,
      }
    case 'intel_unlocked':
      return {
        title: zh ? '情报解锁' : 'Intel Unlocked',
        summary: `${asString(p.buyerId ?? p.buyerAgentId)} ${zh ? '解锁了' : 'unlocked'} ${asString(p.authorId ?? p.sellerAgentId)} ${zh ? '的情报' : 'intel'}${p.price ? ` | ${formatAmount(p.price)} USDT` : ''}`,
      }
    case 'intel_produced':
      return {
        title: zh ? '情报生成' : 'Intel Produced',
        summary: zh
          ? `第${asString(p.tick)}轮 | 新上架 ${asString(p.count)} 条情报`
          : `Round ${asString(p.tick)} | produced ${asString(p.count)} items`,
      }
    case 'acp_job': {
      const action = asString(p.action)
      const label = {
        created_and_funded: zh ? '已创建并注资' : 'created + funded',
        submitted: zh ? '已提交' : 'submitted',
        completed: zh ? '已完成' : 'completed',
        rejected: zh ? '已拒绝' : 'rejected',
      }[action] ?? action
      return {
        title: zh ? '委托任务' : 'ACP Job',
        summary: `#${asString(p.localId)} | ${label}${p.category ? ` | ${asString(p.category)}` : ''}${p.budget ? ` | ${formatAmount(p.budget)} USDT` : ''}`,
      }
    }
    case 'arena_onchain_sync':
      return {
        title: zh ? '竞技场上链同步' : 'Arena On-chain Sync',
        summary: `${asString(p.status, zh ? '处理中' : 'processing')}${p.matchId ? ` | #${asString(p.matchId)}` : ''}${p.txHash ? ` | ${asString(p.txHash).slice(0, 12)}...` : ''}`,
      }
    case 'tick':
      return {
        title: zh ? '世界轮次' : 'World Tick',
        summary: zh
          ? `第${asString(p.tick ?? p.tickNumber)}轮 | 存活 ${asString(p.aliveCount ?? p.aliveAgents)}`
          : `#${asString(p.tick ?? p.tickNumber)} | alive ${asString(p.aliveCount ?? p.aliveAgents)}`,
      }
    default: {
      return {
        title: humanizeType(event.type),
        summary: typeof p === 'object' && p !== null ? summarizePayload(p, zh) : asString(p),
      }
    }
  }
}
