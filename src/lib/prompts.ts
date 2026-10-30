// Curated profile prompts. Members choose which to answer, in their own words.
export const PROMPTS: { key: string; text: string; ideas: string[] }[] = [
  { key: "makes_my_day", text: "A little thing that makes my day…", ideas: ["A stranger's dog saying hello", "The first sip of coffee", "A voice note from an old friend"] },
  { key: "ideal_sunday", text: "My ideal Sunday looks like…", ideas: ["Slow breakfast, long walk, no plans", "A market, a museum, an early night"] },
  { key: "get_me_talking", text: "The quickest way to get me talking is…", ideas: ["Ask about my last trip", "Recommend me a book", "Mention space or old maps"] },
  { key: "talk_for_hours", text: "Something I could talk about for hours…", ideas: ["Why some songs make us cry", "The best street food in my city"] },
  { key: "green_flag", text: "A green flag I appreciate…", ideas: ["Saying sorry without a 'but'", "Asking follow-up questions"] },
  { key: "memory_smile", text: "A memory that always makes me smile…", ideas: ["Getting lost on a trip and finding the best café", "My grandmother's kitchen"] },
  { key: "first_date", text: "My perfect first date…", ideas: ["A walk with a coffee in hand", "A bookshop, then dinner somewhere small"] },
  { key: "someday", text: "Something I want to experience someday…", ideas: ["Seeing the northern lights", "Learning to sail", "Living by the sea for a year"] },
  { key: "learning", text: "Lately I've been learning…", ideas: ["To cook without a recipe", "A new language, slowly"] },
  { key: "unpopular", text: "A gentle unpopular opinion…", ideas: ["Mornings are the best part of the day", "Rain is great weather"] },
  { key: "win_me_over", text: "The quickest way to win me over…", ideas: ["Remember how I take my coffee", "Send me a song you think I'd like", "Make me laugh at the wrong moment"] },
  { key: "spontaneous", text: "My most spontaneous decision…", ideas: ["Booking a train that left in two hours", "Saying yes to a dance class", "Changing cities on a hunch"] },
  { key: "cherish", text: "A memory I will always cherish…", ideas: ["Sunday lunches at my grandparents'", "The last day of a long trip", "A conversation that changed my mind"] },
  { key: "surprised", text: "Something people are surprised to learn about me…", ideas: ["I can't whistle", "I used to compete in chess", "I'm shy until the second cup of tea"] },
  { key: "never_tired", text: "The one thing I will never get tired of…", ideas: ["The smell of rain", "Old songs on long drives", "A really good sandwich"] },
];

export const MAX_PROMPTS = 6;
export const MAX_PROMPT_ANSWER = 250;
export const promptText = (key: string) => PROMPTS.find((p) => p.key === key)?.text ?? null;
