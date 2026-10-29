// Curated Red Flag or Green Flag scenarios. Keys are permanent: reword a prompt freely, but never
// reuse a key for a different scenario, because past rounds point at these rows.
// Discussion prompts are neutral on purpose — no answer is presented as the right one.

export const FLAG_OPTIONS = ["Red Flag", "Green Flag", "It Depends"];

export type Scenario = { key: string; theme: string; prompt: string; discussion: string };

export const FLAG_SCENARIOS: Scenario[] = [
  // Communication and honesty
  { key: "comm-white-lie", theme: "Communication and honesty", prompt: "They tell a small white lie to get out of plans with your friends.", discussion: "Where do you each draw the line between tact and honesty?" },
  { key: "comm-big-news-late", theme: "Communication and honesty", prompt: "They share big news with their friends a day before telling you.", discussion: "What kind of news would you each want to hear first?" },
  { key: "comm-hard-talk-text", theme: "Communication and honesty", prompt: "They bring up something that's bothering them over text rather than in person.", discussion: "Which conversations feel right over text for you, and which don't?" },

  // Boundaries with ex-partners
  { key: "ex-close-friends", theme: "Boundaries with ex-partners", prompt: "They're still close friends with an ex and meet up for coffee now and then.", discussion: "What would help you each feel comfortable with a partner's past relationships?" },
  { key: "ex-old-photos", theme: "Boundaries with ex-partners", prompt: "They still have photos with an ex on their social media.", discussion: "Does the past need tidying away, or is it simply part of someone's story?" },
  { key: "ex-late-call", theme: "Boundaries with ex-partners", prompt: "Their ex calls late at night and they step outside to answer.", discussion: "What context would change how this feels to you?" },

  // Jealousy and trust
  { key: "trust-reads-phone", theme: "Jealousy and trust", prompt: "They glance at your phone when a message lights up the screen.", discussion: "What does privacy look like for each of you in a relationship?" },
  { key: "trust-friend-attention", theme: "Jealousy and trust", prompt: "They feel uneasy when someone flirts with you at a party, and say so on the way home.", discussion: "How would you each like jealousy to be raised, if it comes up?" },
  { key: "trust-location", theme: "Jealousy and trust", prompt: "They suggest sharing locations with each other after two months.", discussion: "What does location sharing mean to each of you: safety, closeness or something else?" },

  // Privacy and independence
  { key: "space-solo-trip", theme: "Privacy and independence", prompt: "They plan a solo trip without asking if you'd like to come.", discussion: "How much time on your own do you each need to feel like yourselves?" },
  { key: "space-passwords", theme: "Privacy and independence", prompt: "They want to share phone passwords in the first month.", discussion: "Is openness about access, or about trust that doesn't need it?" },
  { key: "space-friends-separate", theme: "Privacy and independence", prompt: "They keep their friendship group mostly separate from the relationship.", discussion: "How mixed would you each like your social lives to be?" },

  // Effort and emotional availability
  { key: "effort-remembers", theme: "Effort and emotional availability", prompt: "They remember a small detail you mentioned weeks ago.", discussion: "What small gestures make you each feel noticed?" },
  { key: "effort-slow-replies", theme: "Effort and emotional availability", prompt: "They take a day or two to reply when work gets busy.", discussion: "What does staying connected look like for you during a hectic week?" },
  { key: "effort-hard-day", theme: "Effort and emotional availability", prompt: "When you've had a hard day, they offer solutions before asking how you feel.", discussion: "When you're struggling, what do you each find most supportive?" },

  // Conflict resolution
  { key: "conflict-apologise-first", theme: "Conflict resolution", prompt: "They're usually the first to apologise after a disagreement.", discussion: "What does a good repair after an argument look like to you?" },
  { key: "conflict-needs-space", theme: "Conflict resolution", prompt: "They need a few hours alone before talking through an argument.", discussion: "Do you each prefer to talk things through right away or after some time?" },
  { key: "conflict-raised-voice", theme: "Conflict resolution", prompt: "They raise their voice when they feel unheard, then calm down quickly.", discussion: "What helps each of you feel heard when emotions run high?" },

  // Long-distance relationships
  { key: "distance-nightly-call", theme: "Long-distance relationships", prompt: "In a long-distance relationship, they want a video call every single night.", discussion: "What rhythm of contact would feel close but not heavy to you?" },
  { key: "distance-no-end-date", theme: "Long-distance relationships", prompt: "They're happy to stay long-distance with no plan for when you'll live in the same city.", discussion: "How important is a shared plan for the future when you're apart?" },
  { key: "distance-out-late", theme: "Long-distance relationships", prompt: "While you're apart, they go out most weekends and update you the next morning.", discussion: "What helps you each feel included when you can't be together?" },

  // Commitment and expectations
  { key: "commit-see-where", theme: "Commitment and expectations", prompt: "They say \"let's see where this goes\" after three months together.", discussion: "When would you each want to talk about what this is?" },
  { key: "commit-future-early", theme: "Commitment and expectations", prompt: "They talk about meeting your family on the second date.", discussion: "How quickly do you each like to talk about the future?" },
  { key: "commit-still-on-apps", theme: "Commitment and expectations", prompt: "They keep their dating apps installed until you've talked about being exclusive.", discussion: "What does being exclusive mean to each of you, and when would you want to say it out loud?" },
];
