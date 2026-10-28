// Hand-written suggestions used when AI is disabled, unavailable or over its limits.
// They are deliberately gentle and never pressure anyone to keep talking or to pay.

export const CONVERSATION_STARTERS = [
  "What's something small that made your week better?",
  "If you had a free Sunday with no plans, how would it go?",
  "What's a place you keep meaning to visit in your city?",
  "What's a skill you'd love to learn this year?",
  "What does a good conversation feel like to you?",
  "What's a song you've had on repeat lately?",
];

export const INTEREST_STARTERS: Record<string, string[]> = {
  travel: ["What's the best trip you've taken, and what made it special?", "Mountains or coastline for your next trip?"],
  music: ["Which artist would you go to a concert for, no questions asked?"],
  cooking: ["What's the dish you make when you want to impress someone?"],
  reading: ["What's a book you've recommended to more than one person?"],
  films: ["What film could you rewatch any time?"],
  fitness: ["What's your favourite way to move — gym, sport, or something else?"],
  hiking: ["What's a trail you'd recommend to a beginner?"],
  coffee: ["Do you have a favourite café, or are you still searching?"],
  photography: ["What do you love photographing most?"],
  art: ["Is there an artist or exhibition that stayed with you?"],
  pets: ["Tell me about the animals in your life — past or present."],
  gaming: ["What game have you lost a whole weekend to?"],
};

export const BIO_TIPS = [
  "Lead with something specific: \"Sunday mornings at the farmers' market\" says more than \"I love food\".",
  "Mention what you're hoping for in a sentence — it helps the right people find you.",
  "Add one question someone could answer in their first message.",
  "Keep it warm and honest. Three or four short lines is plenty.",
];

export const REFLECTION_PROMPTS = [
  "What made you feel most like yourself in your last relationship or friendship?",
  "Which of your boundaries would you like a partner to know early on?",
  "What does feeling cared for look like to you on an ordinary day?",
  "What's something you've learned about how you handle disagreements?",
  "What pace feels right for you when getting to know someone new?",
];

export const FIRST_DATE_IDEAS = [
  "A walk and a coffee somewhere public and easy to leave — low pressure for both of you.",
  "A museum, gallery or bookshop visit, so there's always something to talk about.",
  "A daytime food market where you can try a few small things together.",
  "A casual activity like mini golf, bowling or a board-game café.",
];

export const SAFETY_NOTE = "Meet somewhere public for the first time and let a friend know your plans.";
