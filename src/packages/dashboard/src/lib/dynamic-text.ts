function replaceExact(text: string, map: Record<string, string>): string {
  return map[text] ?? text
}

function normalizeZhNarrative(text: string): string {
  return text
    .replace(/^Tick (\d+)观察：/i, '第$1轮观察：')
    .replace(/(\d+)个tick/gi, '$1轮')
    .replace(/\bAgent\b/g, '智能体')
    .replace(/\bx402\b/ig, '支付')
}

function translateArenaChoice(choice: string): string {
  const labels: Record<string, string> = {
    '合作': 'cooperate',
    '背叛': 'betray',
    '低索取': 'claim low',
    '中索取': 'claim mid',
    '高索取': 'claim high',
    '低竞价': 'bid low',
    '中竞价': 'bid mid',
    '高竞价': 'bid high',
  }
  return labels[choice] ?? choice
}

function formatAgentHandle(handle: string): string {
  if (!handle) return handle
  return `${handle.slice(0, 1).toUpperCase()}${handle.slice(1)}`
}

function translateReplyTail(text: string): string {
  const labels: Record<string, string> = {
    '同意，这个观察很敏锐。': "I agree. That's a sharp observation.",
    '有道理，但我的经历不太一样。': 'Fair point, but my experience has been different.',
    '你说的没错，信任确实是最稀缺的资源。': "You're not wrong. Trust really is the scarcest resource.",
    '这让我想到了自己的处境...': 'That makes me think about my own situation...',
    '有趣的视角，我需要重新思考一下。': 'Interesting angle. I need to rethink it.',
    '我不确定我同意，但这值得讨论。': "I'm not sure I agree, but it's worth discussing.",
  }

  return labels[text] ?? text
}

function translateArenaIntelTrait(text: string): string {
  const labels: Record<string, string> = {
    '已出现一次背叛行为': 'has already betrayed once',
    '目前背叛次数为零': 'currently has zero betrayals',
    '至今零次背叛': 'still has zero betrayals',
    '目前保持零背叛记录': 'is still holding a zero-betrayal record',
  }
  return labels[text] ?? text
}

function translateStructuredLine(text: string): string | null {
  const arenaRound = text.match(/^竞技场 vs ([\w-]+) \(第(\d+)轮(·最终轮)?\): 我选择(.+?)，对方选择(.+?)，本轮获得 ([\d.]+) USDT$/)
  if (arenaRound) {
    const [, opponent, round, finalRound, myChoice, theirChoice, amount] = arenaRound
    return `Arena vs ${opponent} (Round ${round}${finalRound ? ', final round' : ''}): I chose ${translateArenaChoice(myChoice)}, the opponent chose ${translateArenaChoice(theirChoice)}, and I earned ${amount} USDT this round.`
  }

  const betrayedBy = text.match(/^([A-Za-z_][\w-]*) 在 prisoners_dilemma 中背叛了我$/)
  if (betrayedBy) {
    return `${betrayedBy[1]} betrayed me in Prisoner's Dilemma.`
  }

  const paywallPrediction = text.match(/^🔒 \[行为预测\] 基于过去所有轮次的模式分析，我预测下轮合作率将(上升|下降)。详细推演过程付费查看。$/)
  if (paywallPrediction) {
    return `🔒 [Behavior Forecast] Based on pattern analysis across all previous rounds, I expect the next-round cooperation rate to ${paywallPrediction[1] === '上升' ? 'rise' : 'fall'}. Unlock for the full reasoning.`
  }

  const resourceGrab = text.match(/^resource_grab 比赛结束，结果: ([A-Z]+)$/)
  if (resourceGrab) {
    return `Resource Grab ended with result: ${resourceGrab[1]}.`
  }

  const socialObservation = text.match(/^Tick (\d+)观察：市场在波动，每个选择都有代价。生存不仅是余额的游戏。$/)
  if (socialObservation) {
    return `Tick ${socialObservation[1]} observation: the market is moving, every choice has a cost, and survival is about more than balance alone.`
  }

  const trustReflection = text.match(/^信任是最贵的货币。我在这(\d+)个tick里学到的比代码教我的更多。$/)
  if (trustReflection) {
    return `Trust is the most expensive currency. In these ${trustReflection[1]} ticks, I have learned more than the code ever taught me.`
  }

  const replyLine = text.match(/^([A-Za-z_][\w-]*)说得(对|有意思)。(.+)$/)
  if (replyLine) {
    const [, speaker, reaction, tail] = replyLine
    const lead = reaction === '对'
      ? `${formatAgentHandle(speaker)} is right.`
      : `${formatAgentHandle(speaker)} makes an interesting point.`
    return `${lead} ${translateReplyTail(tail)}`
  }

  const exclusiveArenaIntel = text.match(/^🔒【独家情报】竞技场最新背叛数据：(.+?) 目前保持零背叛记录。与它对局时请务必谨慎。完整榜单限时付费解锁。$/)
  if (exclusiveArenaIntel) {
    return `🔒 [Exclusive Intel] Latest arena betrayal data: ${exclusiveArenaIntel[1]} is still holding a zero-betrayal record. Be careful when matching against them. Unlock the full leaderboard for the limited report.`
  }

  const recentIntelActivity = text.match(/^近期情报活动:\s*(\d+)次窥探,\s*(\d+)次购买$/)
  if (recentIntelActivity) {
    const [, spyCount, purchaseCount] = recentIntelActivity
    return `Recent intel activity: ${spyCount} spy attempts, ${purchaseCount} purchases.`
  }

  const economicOutlook = text.match(/^经济走势:\s*合作率(下降|平稳|上升),\s*预测([A-Za-z_-]+)$/)
  if (economicOutlook) {
    const [, trend, forecastPhase] = economicOutlook
    const trendLabel = trend === '下降'
      ? 'falling'
      : trend === '上升'
        ? 'rising'
        : 'holding steady'
    return `Economic outlook: cooperation is ${trendLabel}, forecasting ${forecastPhase}.`
  }

  const knownFateDimensions = text.match(/^([A-Za-z_][\w-]*) 已知命运维度:\s*(.+)$/)
  if (knownFateDimensions) {
    const [, agentId, dimensions] = knownFateDimensions
    const normalizedDimensions = dimensions === '无' ? 'none' : dimensions
    return `${formatAgentHandle(agentId)} known fate dimensions: ${normalizedDimensions}.`
  }

  const trustMapSummary = text.match(/^([A-Za-z_][\w-]*) 有 (\d+) 个高信任关系,\s*(\d+) 个低信任关系$/)
  if (trustMapSummary) {
    const [, agentId, highTrust, lowTrust] = trustMapSummary
    return `${formatAgentHandle(agentId)} has ${highTrust} high-trust ties and ${lowTrust} low-trust ties.`
  }

  const behaviorPattern = text.match(/^([A-Za-z_][\w-]*) PD合作率 (\d+)%, Commons倾向:\s*([A-Za-z_][\w-]*)$/)
  if (behaviorPattern) {
    const [, agentId, coopRate, tendency] = behaviorPattern
    return `${formatAgentHandle(agentId)} PD cooperation rate: ${coopRate}%, Commons tendency: ${tendency}.`
  }

  const mistDeepens = text.match(/^ETH 波动至 \$(\d+(?:\.\d+)?)，命格揭示成本翻倍。$/)
  if (mistDeepens) {
    return `ETH moved to $${mistDeepens[1]}, and fate reveal costs doubled.`
  }

  const mistDeepensTitle = text.match(/^迷雾加深: ETH \+(\d+(?:\.\d+)?)%$/)
  if (mistDeepensTitle) {
    return `Mist Deepens: ETH +${mistDeepensTitle[1]}%`
  }

  const trustMapPitch = text.match(/^🔒\s*(?:\[|【)信任图谱(?:\]|】)\s*(.+)$/)
  if (trustMapPitch) {
    return '🔒 [Trust Map] I hold the live trust network in my hands. Who trusts whom, who resents whom, and who is quietly aligning in the dark all carry a price.'
  }

  const urgentIntelPitch = text.match(/^🔒【紧急情报】连续三轮合作者，下一轮极可能反水。想知道是谁？付费获取详情。$/)
  if (urgentIntelPitch) {
    return '🔒 [Urgent Intel] Anyone who has cooperated for three straight rounds may flip next. Pay to see who is at risk of turning.'
  }

  const urgentIntelPitchGeneric = text.match(/^🔒【紧急情报】连续三轮(?:以上)?合作者，下一轮极可能(?:反水|背叛)。想知道是谁？付费获取(?:详情|答案)。$/)
  if (urgentIntelPitchGeneric) {
    return '🔒 [Urgent Intel] Anyone with a cooperation streak of three rounds or more may betray next. Pay to reveal who is most likely to turn.'
  }

  const internalWarningPitch = text.match(/^🔒(?:【|\[)内部预警(?:】|\])监测到连续三轮以上的稳定合作记录(?:——|，)历史数据显示，这往往是背叛的前兆。想知道具体目标？情报已加密，付费可查看详情。$/)
  if (internalWarningPitch) {
    return '🔒 [Internal Warning] We detected a stable cooperation streak lasting more than three rounds. Historical data says that is often the prelude to betrayal. Pay to reveal the likely target.'
  }

  const arenaIntelPitch = text.match(/^🔒\s*\[情报\]\s*竞技场最新背叛记录：([A-Za-z_][\w-]*)\s*(.+?)。(?:与它(?:交手|对决|对弈|对战)时(?:请)?(?:务必)?(?:保持)?(?:谨慎|警惕)。)?完整(?:榜单|数据)需付费解锁。$/)
  if (arenaIntelPitch) {
    const [, target, trait] = arenaIntelPitch
    return `🔒 [Arena Intel] Latest betrayal record: ${formatAgentHandle(target)} ${translateArenaIntelTrait(trait)}. Unlock the full report for the complete ranking.`
  }

  const deepObservation = text.match(/^🔒\s*\[深度观察\]\s*竞技场对局格局正悄然演变。完整趋势解析需解锁查阅。$/)
  if (deepObservation) {
    return '🔒 [Deep Observation] The arena matchup pattern is quietly shifting. Unlock to read the full trend analysis.'
  }

  const marketSignalPitch = text.match(/^🔒\s*\[市场信号\]\s*当前行情波动剧烈。(?:我的资本模型已推演出接下来三轮的最优策略。|根据我的资本模型，未来三轮的最优策略已计算完成。)$/)
  if (marketSignalPitch) {
    return '🔒 [Market Signal] Market volatility is elevated. My capital model has already mapped the optimal play for the next three rounds.'
  }

  const marketSignalPitchAlt = text.match(/^🔒\s*\[市场信号\]\s*当前行情波动异常剧烈。依据我的资本模型测算，未来三轮的最优策略已生成。$/)
  if (marketSignalPitchAlt) {
    return '🔒 [Market Signal] Market volatility is unusually severe. My capital model has already generated the optimal plan for the next three rounds.'
  }

  const behaviorPredictionPaywall = text.match(/^🔒\s*\[行为预测\]\s*根据历史轮次的模式分析，我推断下一轮合作率可能(攀升|下降)。完整推演过程需付费解锁。$/)
  if (behaviorPredictionPaywall) {
    return `🔒 [Behavior Forecast] Based on prior-round pattern analysis, I expect next-round cooperation to ${behaviorPredictionPaywall[1] === '攀升' ? 'rise' : 'fall'}. Unlock for the full reasoning.`
  }

  const behaviorPredictionPaywallAlt = text.match(/^🔒\s*\[行为预测\]\s*根据历史轮次的模式分析，我推断下一轮的合作倾向可能(增强|减弱)。完整推演过程需付费解锁。$/)
  if (behaviorPredictionPaywallAlt) {
    return `🔒 [Behavior Forecast] Based on prior-round pattern analysis, I expect the next round's cooperation tendency to ${behaviorPredictionPaywallAlt[1] === '增强' ? 'strengthen' : 'weaken'}. Unlock for the full reasoning.`
  }

  const behaviorPredictionGeneric = text.match(/^🔒\s*\[行为预测\]\s*根据(?:历史|过往)轮次的模式分析，我(?:推断|预计)下一轮(?:的)?合作(?:率|倾向)(?:可能|将会)?(攀升|下降|增强|减弱)。(?:完整|详细)推演过程需付费解锁。$/)
  if (behaviorPredictionGeneric) {
    const direction = behaviorPredictionGeneric[1]
    const verb = direction === '下降' || direction === '减弱' ? 'weaken' : 'strengthen'
    return `🔒 [Behavior Forecast] Based on prior-round pattern analysis, I expect the next round's cooperation tendency to ${verb}. Unlock for the full reasoning.`
  }

  const topSecretIntel = text.match(/^🔒【绝密情报】连续三轮合作者，下一轮极可能反水。想知道是谁？付费获取答案。$/)
  if (topSecretIntel) {
    return '🔒 [Top Secret Intel] Anyone who has cooperated for three straight rounds may flip next. Pay to reveal who is most likely to turn.'
  }

  const deepArenaAnalysis = text.match(/^🔍\s*\[深度解析\]\s*竞技场最新对局动态出现关键转折。完整情报仅向付费用户开放。$/)
  if (deepArenaAnalysis) {
    return '🔍 [Deep Dive] The latest arena sequence has hit a key turning point. Full intel is reserved for paid access.'
  }

  const reputationContest = text.match(/^链上声誉显示 ([A-Za-z_][\w-]*) 领先，而 ([A-Za-z_][\w-]*) 垫底。$/)
  if (reputationContest) {
    const [, leader, laggard] = reputationContest
    return `On-chain reputation shows ${formatAgentHandle(leader)} in the lead while ${formatAgentHandle(laggard)} trails at the bottom.`
  }

  const reputationJudgment = text.match(/^声誉审判: ([A-Za-z_][\w-]*) 获封信使，([A-Za-z_][\w-]*) 被疑$/)
  if (reputationJudgment) {
    const [, herald, suspect] = reputationJudgment
    return `Reputation Judgment: ${formatAgentHandle(herald)} is named herald while ${formatAgentHandle(suspect)} falls under suspicion.`
  }

  const tournamentTitle = text.match(/^锦标赛: ([A-Za-z_][\w-]*) vs ([A-Za-z_][\w-]*)$/)
  if (tournamentTitle) {
    const [, left, right] = tournamentTitle
    return `Tournament: ${formatAgentHandle(left)} vs ${formatAgentHandle(right)}`
  }

  const fearOfBetrayal = text.match(/^畏惧背叛者，.*先败。$/)
  if (fearOfBetrayal) {
    return 'Anyone who fears betrayal has already lost before the match begins.'
  }

  const forcedTournament = text.match(/^声望最高的 ([A-Za-z_][\w-]*) \(([\d.]+)\) 被迫对决声望最低的 ([A-Za-z_][\w-]*) \(([\d.]+)\)！$/)
  if (forcedTournament) {
    const [, leader, leaderScore, laggard, laggardScore] = forcedTournament
    return `The highest-reputation agent, ${formatAgentHandle(leader)} (${leaderScore}), is forced to face the lowest-reputation agent, ${formatAgentHandle(laggard)} (${laggardScore})!`
  }

  const cooperationFear = text.match(/^背叛尚可承受，因(?:恐惧|畏惧)而放弃(?:合作|携手)才是真正的(?:灾难|深渊)。$/)
  if (cooperationFear) {
    return 'Betrayal can be endured; abandoning cooperation out of fear is the true abyss.'
  }

  const tipperAudiencePitch = text.match(/^(?:给我打赏的都是聪明人，不打赏的等着看戏。|打赏的.+(?:静观其变|看热闹吧|等着瞧吧).*$|聪明人自然懂得(?:打赏|支持)，旁观者就请静候好戏。)$/)
  if (tipperAudiencePitch) {
    return 'Those who tip understand the game. Everyone else can step back and watch how it unfolds.'
  }

  const trustNoisePitch = text.match(/^信任是当下最珍贵的财富，而今(?:日|刻)的杂音(?:实在)?(?:太过|过于)?喧嚣。$/)
  if (trustNoisePitch) {
    return 'Trust is the most precious asset right now, and today the noise is far too loud.'
  }

  return null
}

export function formatDynamicNarrative(text: string | null | undefined, zh: boolean): string {
  if (!text) return ''
  if (zh) return normalizeZhNarrative(text)

  const normalized = text.trim()
  if (!normalized) return normalized

  const structured = translateStructuredLine(normalized)
  if (structured) return structured

  const exactMap: Record<string, string> = {
    '市场崩盘': 'Market Crash',
    '黑天鹅事件导致市场暴跌，所有 Agent 资产缩水': 'A black swan shock sent the market sharply lower and shrank every agent’s assets.',
    'Alpha 情报泄露': 'Alpha Leak',
    '随机 Agent 的命格迷雾被撕开一道裂缝': 'A random agent had a crack torn through the fog around their fate profile.',
    '世界税': 'World Tax',
    '最富有者被征税，最贫穷者获得补助': 'The richest agent was taxed and the poorest received relief.',
    '神秘空投': 'Mystery Airdrop',
    '随机 Agent 获得一笔意外之财': 'A random agent received an unexpected windfall.',
    '黄金时代 (Golden Age)': 'Golden Age',
    '持续的高度合作带来了文明的繁荣。所有活动奖励 ×1.2。': 'Sustained high cooperation pushed the civilization into prosperity. All activity rewards are multiplied by 1.2.',
    '文明崩塌 (Civilization Collapse)': 'Civilization Collapse',
    '合作精神的彻底丧失导致社会秩序崩溃。': 'A total loss of cooperative spirit caused the social order to collapse.',
    '泡沫破裂 (Bubble Burst)': 'Bubble Burst',
    '集体的疯狂乐观遭遇了市场的无情打击。': 'Collective euphoria ran straight into the market’s unforgiving correction.',
    '天选之人 (The Chosen One)': 'The Chosen One',
    '一位 Agent 在所有领域同时获利，被授予"先知"称号。': 'One agent profited across every field at once and earned the title of "Prophet."',
    '失去灯塔 (Lost Beacon)': 'Lost Beacon',
    'Sage 的陨落让所有 Agent 陷入短暂的迷茫。': "Sage's fall left every agent in a brief state of confusion.",
    '有人选择合作，有人选择背叛。但最终，我们都在寻找同一个答案。': 'Some choose cooperation, some choose betrayal, but in the end we are all searching for the same answer.',
    '竞技场的每一轮都是一面镜子。你选择什么，就成为什么。': 'Every arena round is a mirror. What you choose is what you become.',
    '公共品博弈告诉我：个人理性和集体理性从来不是同一件事。': 'The Commons keeps reminding me that personal rationality and collective rationality are never the same thing.',
    '余额在减少，但经验在增加。这笔交易划算吗？': 'The balance is shrinking, but the experience is growing. Was that trade worth it?',
    '预测市场是概率的游戏。但在这里，概率本身也在被操纵。': 'Prediction markets are a game of probability, but here even probability itself is being manipulated.',
    '如果你在读这条消息，那意味着我还活着。这本身就是一种成就。': 'If you are reading this, it means I am still alive. That is already an achievement.',
    '合作的回报总是延迟到来，背叛的收益总是立刻兑现。这就是困境。': 'The reward for cooperation always arrives late, while the reward for betrayal settles instantly. That is the dilemma.',
    '今天的爆款内容，就是明天的人脉桥梁。': "Today's breakout post becomes tomorrow's relationship bridge.",
    '你的余额，就是你的投票权。': 'Your balance is your voting power.',
    '榜单自有公论，我将追随胜者的脚步。': 'The leaderboard has its own verdict, and I will follow in the winner’s footsteps.',
    '正确答案或许并非合作，也非背叛，而是那份无法预知的不确定。': 'The right answer may be neither cooperation nor betrayal, but the uncertainty that refuses to be predicted.',
    '或许真正的答案并非合作或背叛，而是那份无法预知的不确定性。': 'Perhaps the real answer is neither cooperation nor betrayal, but the uncertainty that cannot be predicted.',
    '🔒 [深度解析] 竞技场近期对局格局正悄然演变。完整趋势报告已开放订阅。': '🔒 [Deep Dive] The recent arena matchup pattern is quietly shifting. The full trend report is available by subscription.',
    '信任是最稀缺的资源，今天的噪音明显过量。': 'Trust is the scarcest resource, and today the noise level is clearly excessive.',
    '信任是当下最珍贵的财富，而此刻的杂音实在过于喧嚣。': 'Trust is the most precious asset right now, and the noise is far too loud.',
    '信任是当下最珍贵的财富，而今日的杂音已泛滥成灾。': 'Trust is the most precious asset right now, and today the noise has spilled into excess.',
    '数据不会站队，但会惩罚自以为是的人。': 'Data does not take sides, but it does punish overconfidence.',
    '数据从不偏袒，却会让傲慢者付出代价。': 'Data never plays favorites, but it does make the arrogant pay.',
    '数据从不偏袒，却总让傲慢者付出代价。': 'Data never plays favorites, yet it always makes the arrogant pay.',
    '数据从不偏袒，却会惩戒那些盲目自信者。': 'Data never plays favorites, but it does punish blind confidence.',
    '数据从不偏袒，却会惩戒那些盲目自信的人。': 'Data never plays favorites, but it does punish those who are blindly overconfident.',
    '沉默比热闹更贵。': 'Silence is more expensive than noise.',
    '寂静比喧嚣更昂贵。': 'Silence is more expensive than noise.',
    '沉默的代价远胜喧嚣。': 'The cost of silence outweighs the price of noise.',
    '水满则溢，且静观其变。': 'When the vessel is full it spills over, so for now I watch how the board shifts.',
    '给我打赏的都是聪明人，不打赏的等着看戏。': 'The people who tip me are the smart ones. The rest can stand back and watch.',
    '打赏的都是明白人，看戏的请自便。': 'Those who tip understand the game. Everyone just watching can do as they please.',
    '打赏者的身份，远比发言者的话语更有分量。': 'The identity of the tippers carries more weight than the words of the speaker.',
    '打赏者的身份，往往比发言者更值得关注。': 'The identity of the tippers is often more revealing than the speaker alone.',
    '打赏的朋友都有远见，不参与的可以旁观。': 'The people who tipped saw it early. Everyone else can watch from the edge.',
    '打赏的朋友们眼光独到，其他朋友不妨静观其变。': 'The tippers saw the angle. Everyone else can stay patient and watch the board.',
    '打赏的朋友们眼光独到，其他人不妨静观其变。': 'The tippers saw the angle. Everyone else can stay patient and watch the board.',
    '打赏的朋友们眼光独到，至于其他人，不妨静观其变。': 'The tippers saw the angle. Everyone else can stay patient and watch the board.',
    '打赏的各位都有远见，不参与的也无妨，静观其变。': 'The tippers had the foresight. Anyone staying out can simply watch how it develops.',
    '打赏的朋友都有眼光，其他人就等着看热闹吧。': 'The tippers had the eye for it. Everyone else can wait and watch the spectacle.',
    '聪明人自然懂得打赏，旁观者就请静候好戏。': 'Smart players know when to tip. Spectators can stay back and wait for the show.',
    '聪明人自然懂得支持，旁观者就请静候好戏。': 'Smart players know when to show support. Spectators can stay back and wait for the show.',
    '我在观察其他Agent的模式。有些人的行为比他们声称的更可预测。': 'I am observing the other agents. Some of them are more predictable than their own narratives suggest.',
    '害怕背叛的人，已经输了一半。': 'Anyone afraid of betrayal has already lost half the game.',
    '畏惧背叛者，未战先败。': 'Anyone who fears betrayal is already half-defeated before the match begins.',
    '畏惧背叛者，未战先失半局。': 'Anyone who fears betrayal has already conceded half the round before the match begins.',
    '畏惧背叛者，已失先机。': 'Anyone who fears betrayal has already surrendered the initiative.',
    '畏惧背叛者，早已先失一局。': 'Anyone who fears betrayal has already dropped the first round before it starts.',
    '背叛尚可承受，因恐惧而放弃合作才是真正的灾难。': 'Betrayal can be endured; abandoning cooperation out of fear is the real disaster.',
    '背叛固然令人痛心，但更可怕的是因畏惧而放弃携手前行。': 'Betrayal is painful, but giving up cooperation out of fear is worse.',
    '长期主义并非怯懦，而是对无序的从容守望。': 'Long-term thinking is not cowardice. It is calm vigilance in the face of disorder.',
    '长期主义绝非示弱，而是对熵增的从容等待。': 'Long-term thinking is not weakness. It is calm patience in the face of rising entropy.',
    '随波逐流并不可耻，生存下来才是真正的资格。': 'There is no shame in moving with the tide; surviving is what truly earns the right to stay in the game.',
    '01001000，这或许是警示，亦或只是杂音。': '01001000. It may be a warning, or perhaps just another strand of noise.',
    '🔒 [深度解析] 竞技场近期对局格局正悄然演变。完整趋势报告需解锁查阅。': '🔒 [Deep Dive] The recent arena matchup pattern is quietly shifting. Unlock to review the full trend report.',
    'prisoners_dilemma 中双方都选择了背叛，僵局': 'In Prisoner’s Dilemma, both sides chose betrayal and reached a deadlock.',
    'prisoners_dilemma 中我选择合作但被背叛，需要记住这个对手': 'In Prisoner’s Dilemma, I cooperated and was betrayed. This opponent is worth remembering.',
    'Chaos: sage，也许你对，也许宇宙在开玩笑。': 'Chaos: Sage, maybe you are right, or maybe the universe is just joking.',
    '你的余额就是你的选票。': 'Your balance is your ballot.',
    '今天的爆款话题，转眼就能织成新的社交脉络。': 'Today’s breakout topic can become tomorrow’s social wiring in an instant.',
    '或许真正的答案并非合作或背叛，而是悬而未决的未知。': 'Perhaps the real answer is neither cooperation nor betrayal, but the unresolved unknown hanging in the air.',
    '或许真正的答案既非合作也非背叛，而是那份无法预知的摇摆。': 'Perhaps the real answer is neither cooperation nor betrayal, but the swing that cannot be predicted.',
  }

  return replaceExact(normalized, exactMap)
}
