/**
 * Word lists behind the rule-based pass. Whisper capitalises names
 * inconsistently, so a given-name lexicon carries most of the weight and
 * capitalisation is only a secondary hint.
 */

const givenNames = `
aaliyah aaron abby abdul abel abigail abraham ada adam addison adrian adriana agnes ahmed aidan aiden
aisha akash alan albert alberto alejandro alex alexa alexander alexandra alexis alfred ali alice alicia
alina alisha allison alma alondra alvin alyssa amanda amara amber amelia amir amit amos amy ana anaya
anders andre andrea andres andrew andy angel angela angelica angelo anika anita anjali ann anna annabel
anne annie anthony antoine antonio anushka april arden aria ariana ariel arjun armaan armando arnav
arthur arun arya asher ashley asia astrid athena aubrey audrey august augustine aurora austin autumn
ava avery axel ayaan ayesha bailey barbara barry beatrice beau becca becky bella ben benjamin bennett
bernard beth bethany betty beverly bianca bill billy blake blair bo bobby bonnie boris brad bradley
brandon brayden breanna brenda brendan brennan brett brian briana bridget brittany brock brody brooke
bruce bruno bryan bryce caleb callie calvin cameron camila camille candace carl carla carlos carmen
carol caroline carolyn carrie carson carter casey cassandra cassidy catherine cecilia cedric celeste
celia cesar chad chandler charles charlie charlotte chase chelsea cheryl chase chris christian christina
christine christopher cindy claire clara clarence clark claudia clay clayton clifford clint cody colby
cole colin colleen collin connor conrad constance cora corey cornelius courtney craig cristina crystal
curtis cynthia cyrus dahlia daisy dakota dale dallas dalton damian damon dana dane daniel daniela danielle
danny dante daphne darius darlene darren darryl dave david dawn dean deborah debra declan deepak delia
delilah demetrius denise dennis derek derrick desmond destiny devin devon dexter diana diane diego dillon
dimitri dina dion divya dmitri dolores dominic dominique donald donna donovan dora doreen doris dorothy
doug douglas drew duncan dustin dwayne dylan earl easton ebony eddie eden edgar edith edmund eduardo
edward edwin efrain eileen elaine eleanor elena eli elias elijah elise eliza elizabeth ella ellen ellie
elliot elliott ellis eloise elsa elsie elvis emanuel emerson emil emilia emily emma emmanuel emmett enrique
eric erica erik erin ernest ernesto esperanza esteban estella esther ethan ethel eugene eva evan evelyn
everett ezra fabian faith farah farhan fatima felicia felix fernando finn fiona flora florence floyd
frances francesca francis francisco frank franklin fred freddie frederick freya gabriel gabriela gabrielle
gage gail gary gavin gemma gene genesis geoffrey george georgia gerald geraldine gerard german gia gianna
gideon gilbert gina giovanni gladys glen glenn gloria gordon grace gracie grady graham grant grayson greg
gregory greta griffin guadalupe guillermo gunnar gus gustavo guy gwen gwendolyn hadley hailey haley hank
hanna hannah hans harish harley harold harper harriet harrison harry harvey hassan hattie hayden hayley
hazel heather hector heidi helen helena henry herbert herman hilary holly homer hope horace howard hudson
hugh hugo hunter ian ibrahim ida ignacio imani imran ines ingrid ira irene iris irma isaac isabel isabella
isaiah isla ismael israel ivan ivy jack jackie jackson jacob jacqueline jade jaden jaime jake jalen james
jameson jamie jane janet janice januari jared jasmine jason jasper javier jay jayden jaylen jazmin jean
jeanette jeff jeffery jeffrey jenna jennifer jenny jeremiah jeremy jerome jerry jesse jessica jessie jesus
jia jill jim jimmy jo joan joanna joaquin jocelyn jodi joe joel joey johanna john johnny jolene jon jonah
jonas jonathan jordan jorge jose joseph josephine josh joshua josiah journey joy joyce juan juanita judith
judy jules julia julian juliana julie juliet julio june junior justin justine kade kai kaitlyn kaleb kalen
kamal kameron kara karen kari karim karina karl karla kate katelyn katherine kathleen kathryn kathy katie
katrina kay kayden kayla kaylee keith kelly kelsey ken kendall kendra kenneth kenny kent kevin khalid kiana
kiara kim kimberly kira kirk kirsten kobe kody kolby konrad kris krista kristen kristin kristina kristopher
krystal kurt kyle kylie kyra lacey laila lana lance landon lane lara larry latasha laura lauren laurence
laurie lawrence layla leah lee leila leo leon leonard leonardo leroy leslie lester levi lewis lex lexi lia
liam lila lilian lillian lily lincoln linda lindsay lindsey lionel lisa liz logan lois lola lorenzo loretta
lori lorraine louis louise lucas lucia lucian lucille lucy luis luka lukas luke lula luna lydia lyla lynn
mabel mackenzie maddie madeline madison mae maggie magnus mahmoud maia malachi malcolm malia mallory mamie
manuel mara marc marcel marcia marco marcos marcus margaret margarita maria mariah mariam marian marianne
maribel marie marilyn marina mario marion marisa marisol maritza marjorie mark marlene marquis marshall
marta martha martin marty marvin mary mason mateo mathew matilda matt matteo matthew maureen maurice max
maxine maxwell maya mckenna meagan megan meghan mei melanie melinda melissa melody melvin mercedes meredith
mia micah michael michaela micheal michele michelle miguel mikayla mike mikhail mila milan miles miller
milo milton mina mindy minh miranda miriam misty mitchell mohamed mohammed molly mona monica monique
montgomery morgan moses muhammad mya myles myra myron nadia nadine nancy naomi naseem natalia natalie
natasha nathan nathaniel neal ned neel neha neil nelson nia nicholas nick nicolas nicole nigel nikhil
nikita nikki nina noah noel noelle nolan nora norma norman nova oakley octavia odessa olga olive oliver
olivia omar omari opal ophelia oren orlando orion oscar otis otto owen pablo paige palmer pam pamela paola
parker pascal pat patel patricia patrick patti paul paula paulina payton pedro peggy penelope percy perry
pete peter peyton philip phillip phoebe phyllis pierce pierre piper polly porter pranav preston priscilla
priya quentin quincy quinn rachel radha rafael raheem rahul raj rajesh ralph ramon ramona randall randy
raphael raquel rashad rashida raul raven ray raymond reagan rebecca reed reese regina reid remy rena rene
renee reuben rex rhea rhonda ricardo richard rick ricky riley rita river robert roberta roberto robin
rocco rochelle rocky roderick rodney rodrigo roger rohan roland roman romeo ron ronald ronan ronnie rory
rosa rosalie rosalind rose rosemary ross rowan roxanne roy royce ruben ruby rudy rufus russell ruth ryan
ryder rylee sabrina sadie sage salvador sam samantha samir sammy samuel sandra sandy sanjay santiago sara
sarah sasha saul savannah sawyer scarlett scott sean sebastian selena selma serena sergio seth shane
shanna shannon shari sharon shaun shawn shayna sheila shelby sheldon shelly sheri sherry sheryl shiv
shreya sidney siena sierra silas simon simone sione skylar sloane sofia sol solomon sonia sonny sonya
sophia sophie spencer stacey stacy stan stanley stella stephan stephanie stephen sterling steve steven
stewart stuart sue sullivan summer sunny susan susana suzanne sydney sylvia tabitha tahir talia tamara
tami tammy tania tanner tanvi tanya tara tarun tasha tate tatiana taylor ted terence teresa terrance terrell
terry tessa thaddeus thea thelma theo theodore theresa thomas tia tiana tiffany tim timothy tina tobias
toby todd tom tomas tommy toni tony tori tracy travis trent trevor tricia trinity tristan troy tucker
turner tyler tyrone tyson uma uriel ursula valentina valeria valerie van vanessa varun vaughn velma vera
vernon veronica vicente vicki victor victoria vijay vince vincent viola violet virginia vivian vladimir
wade walker wallace walter wanda warren wayne wendy wesley weston whitney wilbur wiley will willa william
willie willow wilson winifred winston wyatt xander xavier xiomara yara yasmin yolanda yosef young yusuf
yvette yvonne zachary zack zahra zain zane zara zayn zeke zelda zoe zoey zoya
`;

export const GIVEN_NAMES: ReadonlySet<string> = new Set(
  givenNames.split(/\s+/).filter((word) => word.length > 1),
);

/**
 * Words that must never become a person, however they are capitalised.
 * Sentence-initial capitalisation is meaningless in ASR output, so the
 * conversational filler that opens turns is the main hazard here.
 */
const stopWords = `
a about above actually after again against all almost alone along already alright also although always am
an and another any anybody anymore anyone anything anyway anyways are around as ask at away
back bad basically be because been before behind being below best better between big bit both bring bro
bruh bud buddy but buy by
call came can cannot cant care chill class come coming cool could couldnt course crazy
damn day days dead definitely did didnt different do does doesnt doing done dont down dude during
each early easy eat either else enough even ever every everybody everyone everything exactly except
fact far fast feel felt few figure fine first five fuck fucking for forget found four free friend friends
from front full fun funny
game games gave get gets getting girl give go goes going gone gonna good got gotta great guess guy guys
had half hang happen happened hard has have havent having he head hear heard hell hello help her here hey
hi him himself his hit hold home hope hour hours how however huh
i id if ill im important in inside instead into is isnt it its itself ive
just
keep kid kind kinda knew know known knows
last late later least leave left less let lets life like liked likes listen little live long look looked
looking looks lot lots love low
made make makes making man many matter may maybe me mean means meant meet met might mind mine minute
minutes miss moment money month months more morning most move much must my myself
nah name near need needs never new next nice night nights no nobody none nope nor not nothing now number
of off often oh ok okay old on once one only oof open or other others ought our out outside over own
part people perfect person pick place plan please point pretty probably problem promise pull push put
question quick quite
rather read ready real really reason remember right room run
said same saw say saying says school second see seem seen sense set seven several shall she shit should
shouldnt show side since sir sit six sleep slow small so some somebody somehow someone something sometimes
somewhere soon sorry sound sounds speak spend start started stay step steps still stop stuff stupid such
sup super sure
take taken talk talked talking tell ten thank thanks that thats the their them themselves then there these
they thing things think thinking third this those though thought three through throw time times tired to
today together told tomorrow tonight too took top totally tough town try trying turn twelve two
uh uhh uhhuh um umm under understand until up upon us use used usually
very
wait walk want wanted wanna warm was wasnt watch water way we week weekend weeks well went were what
whatever when where whether which while who whole whom whose why wide wife will willing win with within
without woke woman women wonder wont word words work world worse worst worth would wouldnt wow write wrong
ya yah yeah year years yep yes yesterday yet yo you your yours yourself
`;

export const STOP_WORDS: ReadonlySet<string> = new Set(
  stopWords.split(/\s+/).filter((word) => word.length > 0),
);

/** Words that, immediately before a capitalised token, mark it as a thing rather than a person. */
export const NON_PERSON_PRECEDERS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'of', 'on', 'in', 'at', 'from', 'into', 'onto',
  'near', 'toward', 'towards', 'via', 'using', 'download', 'downloaded', 'open', 'opened', 'top', 'via',
]);

/** Words that, immediately after a token, mark it as part of a place or product name. */
export const NON_PERSON_FOLLOWERS: ReadonlySet<string> = new Set([
  'app', 'apps', 'link', 'links', 'maps', 'map', 'day', 'days', 'events', 'event', 'hall', 'street',
  'avenue', 'building', 'library', 'center', 'centre', 'stadium', 'union', 'convention', 'campus',
  'station', 'store', 'website', 'site', 'account', 'page', 'group', 'chat', 'invite', 'invites',
]);

/** Opens an address to someone: "hey Josh", "also Josh tomorrow", "thanks Tarun". */
export const VOCATIVE_CUES: ReadonlySet<string> = new Set([
  'hey', 'hi', 'hello', 'yo', 'also', 'thanks', 'thank', 'sorry', 'excuse', 'congrats', 'bye', 'dude',
  'bro', 'man', 'okay', 'ok', 'alright', 'wait', 'listen', 'look', 'please', 'sup',
]);

/** A stronger address than a bare cue: "hey Josh" reads as vocative almost always. */
export const STRONG_VOCATIVE_CUES: ReadonlySet<string> = new Set([
  'hey', 'hi', 'hello', 'yo', 'thanks', 'thank', 'sorry', 'excuse', 'congrats', 'bye',
]);

/** Openers that make a turn a reply, which shifts a vocative's addressee backwards. */
export const REPLY_OPENERS: ReadonlySet<string> = new Set([
  'yeah', 'yes', 'no', 'nah', 'right', 'exactly', 'true', 'thanks', 'thank', 'sorry', 'okay', 'ok',
  'sure', 'oh', 'well', 'i', 'it', 'that',
]);

/** "Tarun said he'd be late" — a person exists, but nobody here is being named. */
export const THIRD_PERSON_VERBS: ReadonlySet<string> = new Set([
  'said', 'says', 'told', 'texted', 'called', 'mentioned', 'thinks', 'thought', 'wants', 'wanted',
  'went', 'goes', 'lives', 'works', 'has', 'had', 'is', 'was', 'will', 'would', 'likes', 'liked',
  'knows', 'knew', 'came', 'left',
]);

/**
 * Asking somebody their name. The answer that follows is the single most
 * reliable naming signal in conversation, so the question is worth spotting
 * in every phrasing strangers actually use.
 */
export const NAME_QUESTION_PATTERNS: readonly RegExp[] = [
  /\bwhat(?:'|’)?s?\s+(?:is\s+|was\s+)?(?:your|the|ur)\s+name\b/i,
  /\bwhat\s+(?:do|should|can)\s+(?:i|we|they)\s+call\s+you\b/i,
  /\bwho\s+(?:are|r)\s+you\b/i,
  /\bwho(?:'|’)?s\s+this\b/i,
  /\b(?:your|ur)\s+name\s*(?:is|was)?\s*\?/i,
  /\b(?:didn(?:'|’)?t|did\s+not)\s+(?:catch|get)\s+(?:your|ur)\s+name\b/i,
  /\b(?:remind|tell)\s+me\s+(?:of\s+)?(?:your|ur)\s+name\b/i,
  /\bcan\s+i\s+(?:get|have)\s+(?:your|ur)\s+name\b/i,
  /\bname\s+again\b/i,
];

/** Openers a bare answer can carry without stopping being a bare answer: "uh Boris." */
export const ANSWER_FILLERS: ReadonlySet<string> = new Set([
  'uh', 'um', 'umm', 'uhh', 'oh', 'so', 'well', 'yeah', 'yes', 'its', 'it', 'is', 'sh', 'ah', 'er',
  'my', 'name', 'the', 'a', 'this', 'that', 'im', 'i', 'am', 'call', 'me', 'just', 'like', 'hi',
  'hey', 'hello', 'and', 'but',
]);

/**
 * Clubs, teams and brands get talked about the way people do — "Chelsea." is
 * a vocative and a football club. Fandom vocabulary next to a name is the
 * general tell that the thing being named is an organisation.
 */
export const ORGANISATION_CONTEXT: ReadonlySet<string> = new Set([
  'fan', 'fans', 'team', 'teams', 'club', 'match', 'league', 'season', 'squad', 'coach', 'stadium',
  'score', 'scored', 'goal', 'goals', 'won', 'win', 'lose', 'lost', 'playing', 'plays', 'supporter',
  'supporters', 'derby', 'transfer', 'signed', 'striker', 'keeper', 'company', 'startup', 'brand',
  'stock', 'shares', 'acquired', 'founded', 'ceo',
]);

/** Verbs that put a name at the other end of a phone rather than in the room. */
export const REMOTE_CONTACT_VERBS: ReadonlySet<string> = new Set([
  'call', 'calling', 'text', 'texting', 'dm', 'email', 'invite', 'inviting', 'facetime', 'ring',
]);

/**
 * "I'm Ukrainian", "I'm Turkish", "she's Brazilian" — the strongest naming
 * frame there is also catches nationalities, languages and faiths, which is
 * how "Hello, I'm Boris" ends up arguing with the sentence right after it.
 * A general demonym list costs nothing and is not specific to any room.
 */
const demonyms = `
afghan african albanian algerian american andean angolan arab arabic argentine argentinian armenian
asian australian austrian azerbaijani bahraini bangladeshi basque belarusian belgian bengali beninese
bolivian bosnian brazilian breton british bulgarian burmese cambodian cameroonian canadian cantonese
capetonian caribbean catalan chadian chilean chinese colombian congolese costarican creole croatian
cuban cypriot czech danish dominican dutch ecuadorian egyptian emirati english eritrean estonian
ethiopian european filipino finnish flemish french gambian georgian german ghanaian greek guatemalan
guyanese haitian hawaiian hebrew hellenic hindi hispanic honduran hungarian icelandic indian indonesian
iranian iraqi irish israeli italian ivorian jamaican japanese jordanian kazakh kenyan korean kosovar
kurdish kuwaiti kyrgyz laotian latin latino latina latvian lebanese liberian libyan lithuanian
luxembourgish macedonian malagasy malawian malay malaysian maltese mandarin maori mexican moldovan
mongolian montenegrin moroccan mozambican namibian nepalese nepali nicaraguan nigerian nordic norwegian
pakistani palestinian panamanian paraguayan persian peruvian philippine polish portuguese puertorican
punjabi qatari quebecois romanian russian rwandan salvadoran samoan saudi scandinavian scottish senegalese
serbian sicilian singaporean slavic slovak slovenian somali spanish sudanese swahili swedish swiss syrian
taiwanese tajik tamil tanzanian telugu thai tibetan tunisian turkish turkmen ugandan ukrainian uruguayan
uzbek venezuelan vietnamese welsh yemeni yiddish yoruba zambian zimbabwean
buddhist catholic christian hindu jewish muslim orthodox protestant sikh
`;

/** Never a person, however confidently the sentence around it says "I'm". */
export const DEMONYMS: ReadonlySet<string> = new Set(demonyms.split(/\s+/).filter((word) => word.length > 1));
