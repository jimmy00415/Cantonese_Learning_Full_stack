Cantonese Learning Bot – Product Iteration PRD (v2.0)

Version: 2.0
Last Updated: February 1, 2026

Core Improvement Objectives

Mode-based Experience: Introduce distinct Teaching Mode and Free Talk Mode to cater to different user needs. This addresses feedback that the current single mode cannot satisfy both formal learning and casual practice effectively.

Deep Localization: Greatly enhance the bot’s understanding and teaching of authentic Hong Kong Cantonese culture, including local slang, abbreviations, mixed Cantonese-English phrases, and context-specific expressions.

Intelligent Interaction: Improve the system’s tolerance and guidance for learner errors (especially for non-native speakers) to make conversations more natural and less frustrating.

Foundational Experience Optimization: Fix critical bugs and polish the UI/UX for a more stable, professional user experience. This includes ensuring consistent Text-to-Speech (TTS) output and smoother overall performance.

Dual-Mode Experience (Teaching Mode & Free Talk Mode)

User Pain Points: Users reported that the bot’s single interaction style is either too corrective during casual chat or not instructional enough during practice. For example, some users wanted a dedicated “teacher mode” focused on corrections, separate from an open conversation mode. Others felt the AI’s corrections in a casual chat made the conversation feel overly formal and inauthentic.

Proposed Solution: Implement two clearly separate interaction modes:

Teaching Mode – A structured mode where the AI behaves like a language tutor. In this mode, the bot will strictly correct pronunciation, grammar, and word usage errors, providing detailed explanations and proper examples. The dialogue here is intentionally more formal and instructional, helping users improve accuracy and learn proper usage.

Free Talk Mode – A conversational mode where the AI acts as a friendly chat partner. This mode prioritizes natural flow and user confidence: the bot will tolerate minor mistakes and colloquial expressions, intervening less frequently so that conversations remain fluid and enjoyable. The AI will use and understand Cantonese slang or casual language, creating an authentic chat experience without over-correcting.

Key Functional Requirements:

Provide a mode toggle in the UI for users to switch between Teaching and Free Talk modes at any time.

Teaching Mode behavior: The system must identify and correct user errors in speech or text (pronunciation, grammar, vocabulary) every time they occur. It should provide an explanation for each correction and model the correct way to say it. The tone is encouraging but formal (teacher-like).

Free Talk Mode behavior: The system should allow informal Cantonese conversation. Minor errors are generally not corrected unless they impede understanding. The AI uses a friendly tone, infuses local slang or humor when appropriate, and focuses on keeping the conversation going naturally.

Ensure mode persistence: the bot remembers the selected mode throughout the session (and possibly between sessions) until changed by the user.

(Future consideration) Code-Mixing Mode: Plan for a future enhancement to support Hong Kong style Cantonese that frequently mixes English and Cantonese (Cantonese-English code mixing). This could be a sub-mode or an extension of Free Talk mode, where the AI can seamlessly handle mixed-language sentences.

Success Metrics:

Mode Adoption: At least a 40%/60% split between Teaching Mode and Free Talk Mode usage, respectively, indicating both modes are being utilized (target ~40% of active users use Teaching Mode, ~60% use Free Talk Mode).

User Engagement: Increase overall user engagement as reflected by Daily Active Users/Weekly Active Users (DAU/WAU) ratio, targeting a 20% improvement (as users find the mode that suits their learning style).

User Feedback: Positive qualitative feedback from users about having the flexibility of two modes (e.g. comments that the app feels both “professional” and “fun” depending on mode) – contribute to higher satisfaction (supports NPS goal).

Local Slang & Cultural Context Engine

User Pain Points: The bot currently struggles with Hong Kong-specific expressions and cultural context. Early users noted cases where local slang or abbreviations were not understood – for example, the phrase “要一碗靓仔” (a café slang for a type of dish) confused the AI. Abbreviations commonly used by locals (e.g. “reg” for register, “sem” for semester) were not recognized. Additionally, when users used Cantonese swear words or colloquial exclamations, the bot’s only response was to label them as vulgar, rather than explaining their meaning or appropriate usage. This lack of cultural understanding made the learning experience feel incomplete and “inauthentic.”

Proposed Solution: Develop a Cultural Context Engine to embed deep Cantonese cultural knowledge into the bot’s understanding and responses. This involves:

Building a comprehensive local Cantonese knowledge base covering slang, idioms, regional phrases, cafe terminology, common code-mixed words, and internet memes prevalent in Hong Kong.

Enhancing the AI’s language model to recognize and interpret these terms correctly in user input, and to use them appropriately in its own responses (especially in Free Talk Mode for authenticity).

Implementing contextual explanations in Teaching Mode: when a user uses (or encounters) a local slang term, abbreviation, or even a curse word, the AI in Teaching Mode will not just translate or scold, but teach the term’s meaning, nuance, and proper context. For example, if a user says a Cantonese slang or expletive, the bot might respond with a brief cultural note: “The term ‘痴线’ is a casual slang meaning ‘crazy’ or ‘ridiculous’. Friends might say it jokingly, but it’s not polite to use in formal situations or with elders. A more polite way to express this idea would be...’’. This turns potentially sensitive language into a learning opportunity.

Ensuring Cantonese-English code-mix support: Recognize mixed-language sentences (e.g., “我今晚要去library温书” mixing Cantonese and English). The engine should parse mixed inputs and respond in kind, teaching any code-mixed vocabulary as needed. (Note: full code-mixing support may roll out gradually, with a dedicated mode in future if needed.)

Key Functional Requirements:

Localized Database: Create and maintain a database of Hong Kong Cantonese slang, idiomatic expressions, café-order jargon, common abbreviations, and popular internet slang. The database should be easily updatable as new slang emerges.

NLP Integration: Update the Natural Language Understanding and Generation components to utilize this database. The AI should match user inputs against known slang/phrases and generate context-aware responses. Unknown slang should be flagged for curation to add to the knowledge base.

Teaching Mode Responses: For any slang or sensitive term used by the user, the Teaching Mode response must include a brief definition and cultural context. If the term is vulgar or sensitive, include guidance on politeness and alternatives (as exemplified with “痴线” above).

Free Talk Responses: In casual mode, the AI should be able to understand and naturally use local slang and mixed language, to make conversation flow realistic. It should not overly censor or avoid slang in Free Talk Mode (except to ensure the response is appropriate to the user’s level and the conversation context).

Continuous Learning: Logging of any term the AI fails to understand (that might be slang or abbreviation) for review. This ensures the cultural database can be expanded continuously based on real user input.

Content Moderation Balance: Continue to avoid truly inappropriate content, but handle borderline slang or swears in an educational manner rather than a blunt refusal, especially in Teaching Mode.

Success Metrics:

Authenticity Feedback: Increase in positive user feedback mentioning the bot’s authenticity and cultural relevance. Aim to collect 100+ public feedback mentions that the bot feels “地道” (authentic/local), “智能” (intelligent in understanding context), or “好用” (easy to use) in app reviews or community forums. This indicates users notice and appreciate the local language support.

Learner Uptake of Slang: Track the Colloquial Suggestion Adoption Rate – when the bot suggests a more natural local expression or correct context for a phrase, measure how often users successfully use that suggestion later. Target a 15% increase in adoption of Cantonese colloquial suggestions in subsequent user conversations.

Improved Comprehension: Reduction in instances of “AI didn’t understand my slang/abbreviation.” This can be measured via support tickets or logs (qualitative goal: approaching zero misunderstandings of common slang after database implementation).

NPS Impact: By enriching cultural context, we expect overall user satisfaction to rise (contributing to a Net Promoter Score increase of ~10 points), as users feel the bot is a genuinely knowledgeable Cantonese companion.

Core Experience Stability & TTS Consistency

User Pain Points: Fundamental issues in the current version are undermining the user experience. Users have reported occasional system lag or freezes, especially during extended sessions, which disrupts practice sessions. The voice interaction has a critical gap: users cannot interrupt the AI’s speech output, meaning if the AI starts a long response, the user must wait until it finishes speaking before they can say anything or correct a misunderstanding. In addition, the Text-to-Speech (TTS) system’s consistency is problematic – the same word can be pronounced differently within a single sentence, confusing learners (e.g., the word “咖喱” was pronounced with inconsistent tone/intonation in one instance). There’s also inconsistency in written output: for Cantonese content, the bot sometimes responds in Simplified Chinese text even when users expected Traditional characters, causing confusion.

Proposed Solution: Prioritize core stability fixes and consistency improvements to provide a solid foundation for learning:

Performance and Stability Fixes: Identify and resolve the root causes of any UI freezes or audio recording glitches. Optimize the app’s performance to handle long sessions without lag. This may involve memory leak fixes, audio processing improvements, and better state management so the recording status is always correctly recognized.

Interrupt Functionality: Implement a feature that allows the user to immediately stop the AI’s speaking. For instance, if the AI is reading a long explanation, the user can press a “Stop/Interrupt” or use the push-to-talk button to cut off the TTS, allowing them to ask a follow-up or rephrase their question without waiting. This makes the interaction more efficient and user-controlled.

TTS Output Consistency: Update the TTS engine or its configuration so that it uses a consistent pronunciation lexicon for Cantonese. The same word should have a uniform pronunciation across contexts. This might involve refining the phonetic dictionary or improving the context handling of the TTS system so it doesn’t generate different pronunciations for identical words. Also ensure the chosen TTS voice and accent remain consistent (no unexpected changes in speaking style).

Unified Script Display: Introduce a user setting for display language (Simplified vs. Traditional Chinese). The app should automatically render all interface text and AI responses in the script that matches the user’s choice or device locale. For example, if the user selects Traditional Chinese, the AI’s Cantonese text output should appear in Traditional characters. This removes confusion for Cantonese learners who prefer Traditional Chinese (commonly used in Hong Kong) over Simplified.

Key Functional Requirements:

Bug Fixes: Resolve the audio recording bug where the app fails to exit “recording” state or gets stuck after long use. Ensure smooth transition between listening and speaking states.

System Performance: Conduct performance testing and optimization to eliminate any UI stutter or freeze during conversation. Set a threshold that the app should maintain responsive audio processing even after >30 minutes of continuous use.

Interrupt Mechanism: Add an “interrupt” control – e.g., if the user presses and holds the microphone button while the AI is talking, it should immediately stop speaking and listen to the user. Visibly indicate that speaking was canceled (maybe a subtle sound cut-off or visual feedback) so the user knows they can start talking.

TTS Engine Update: Use a consistent Cantonese TTS pronunciation dictionary. For any given Cantonese word, map it to one standard pronunciation. Test a list of common words (including polyphonic words) in sentences to verify consistency. Also, maintain a single voice persona for all TTS output in the session to avoid any variation.

Language Display Setting: In the settings menu, provide options for “Interface Language/Script: Simplified Chinese / Traditional Chinese / English.” The choice should instantly apply to all UI labels. Additionally, the AI’s response text should follow the chosen script for Chinese (while of course the spoken output remains Cantonese audio). For English interface selection, ensure the UI is in English but the AI can still converse in Cantonese as needed (this just affects menus and possibly the presence of translations).

Testing & QA: Before release, perform regression testing for all above fixes: no recurrence of freezes in test sessions, verify interrupt works in various scenarios, TTS outputs consistent in a sample of dialogues, and UI text toggles correctly when language is switched.

Success Metrics:

Stability: 100% elimination of critical P0 bugs related to freezing or recording issues – i.e., zero known occurrences of the major lag/recording bugs in production. Stability can also be measured by crash-free sessions or no user reports of the specific lag issue post-fix.

User Control: Increased user agency – e.g., measure usage rate of the interrupt feature (how often users utilize it when AI is speaking) as a proxy that it’s useful. Aim for a significant portion of long responses being interrupted interactively (exact metric TBD internally).

Consistency: Zero complaints about TTS inconsistency in user feedback after the update. The success can be gauged via user testing where learners agree that pronunciation consistency improved.

Satisfaction: Overall, these foundational fixes should reflect in improved user ratings for reliability. They contribute to a higher NPS and more positive comments about the app being “responsive” and “professional” (supporting the NPS +10 goal and general satisfaction).

Intelligent Feedback & Error Recovery System

User Pain Points: Learners, especially non-native Cantonese speakers, often need a more forgiving and guided interaction. Two main issues were highlighted in feedback:

Speech Pauses and Cut-offs: Users who pause mid-sentence (for thinking or translating in their head) often find the bot stops listening too soon or misinterprets the input. One user noted that if they hesitated or had a long pause while speaking, the system wouldn’t catch their full sentence, leading to misunderstandings or the need to repeat.

Lack of On-Demand Correction: The bot’s corrections were either too implicit or only triggered at the bot’s discretion. A user expressed that they wish the AI would correct their word choice or grammar, not just answer questions. Currently, if the AI doesn’t correct something automatically, the user has no clear way to ask for correction except by rephrasing and hoping for feedback. This leaves some errors unaddressed and frustrates users who actively want to learn from mistakes.

Proposed Solution: Enhance the Smart Feedback System to make the bot more accommodating to user errors and more responsive to requests for help:

Improved Pause Handling: Adjust the voice input logic to allow longer pauses before the system finalizes a user’s speech input. For example, extend the end-of-speech silence threshold to ~2-3 seconds. This gives learners time to think in the middle of a sentence without being cut off. Additionally, implement a gentle prompt during long pauses: if the system detects the user has been silent for a moment (e.g. >2 seconds) but likely hasn’t finished, the bot can play a subtle sound or a short encouragement like “唔紧要，慢慢讲。” (“No worries, take your time.”) to let the user know they can continue at their pace. This reduces anxiety and makes the experience more human and patient.

User-Initiated Corrections: Introduce a simple mechanism for users to request immediate feedback on their last utterance. This could be a voice command (e.g., the user says "請幫我糾正" / "please correct me") or a tap of a “Correct Me” button right after speaking. When invoked, the AI will enter a brief “review” mode: it will analyze the user’s most recent sentence and provide corrections and suggestions for improvement, instead of moving the conversation forward. This feature gives motivated learners control over when they want explicit teaching.

Proactive Colloquial Suggestions: Build on the above mechanism to also handle cases where a user’s phrasing is technically correct but overly formal (using bookish or written-style Chinese). In such cases, especially in Teaching Mode, the AI should suggest a more natural Cantonese way to say the phrase. For example, if a user uses a very formal term or a direct translation from Mandarin, the bot might suggest a colloquial Cantonese alternative. These suggestions will help users sound more native. This ties into tracking colloquial suggestion adoption as a success metric.

Error Tolerance in Free Talk: Ensure that in Free Talk Mode, the above improvements do not make the bot overbearing; the bot should use the pause detection and encouragement to support the user, but still refrain from unsolicited detailed corrections unless the user asks. The goal is to make the conversation flow while still allowing recovery if the user gets stuck.

Key Functional Requirements:

End-of-Speech Tuning: Increase the speech detection timeout to at least 2 seconds of silence before ending input recognition. Make this value tunable based on user behavior (e.g., potentially even adaptive: if a user often pauses, the system could dynamically allow longer pauses).

Pause Prompt: Implement a non-intrusive prompt after a prolonged pause. This could be a visual indicator (e.g., the recording waveform gently pulsing) or a short phrase like “Take your time” played via TTS. Ensure this prompt triggers only once per user turn and only when a pause exceeds the threshold, so it doesn’t interrupt the user if they resume talking quickly.

“Correct Me” Command: Add support for a special command. This includes:

Voice command recognition for phrases like “帮我纠正” (in Cantonese or Mandarin) or “correct me” (in English) at the end of user speech input.

A UI button that becomes active after the user finishes speaking, labeled e.g. “Get Correction” for manual triggering.

When triggered, the system does not generate a normal conversational reply. Instead, it generates a feedback message analyzing the user’s last statement. This feedback should highlight any pronunciation errors, incorrect word choices, or unnatural phrasing, and provide the correct form or a suggestion.

After giving the correction, the bot can return to normal mode for the next user input.

Colloquial Reformulation Logic: Integrate a check in the feedback analysis for “formal vs. colloquial language.” This could use a list of formal expressions mapped to colloquial counterparts. If the user’s sentence is grammatically correct but uses overly formal words that a native speaker wouldn’t use in casual speech, the correction feedback should include a note like: “A more natural way to say this is: ...”. Encourage the user to repeat or practice the colloquial version.

Mode-Appropriate Behavior: Only provide automatic corrections or colloquial suggestions unsolicited in Teaching Mode (as part of its strict correction policy). In Free Talk Mode, such detailed feedback should be provided only if the user explicitly requests it (via the command/button), to keep the chat spontaneous unless help is asked for.

Conversation Continuity: After delivering a requested correction or handling a pause, ensure the conversation can continue smoothly. For example, after a correction, the bot might ask a follow-up question or give the user a chance to try saying the corrected phrase, then proceed with the dialogue.

Success Metrics:

Error Recovery Rate: Measure a decrease in conversation drop-offs or misunderstandings due to pauses. For instance, track instances where users had to repeat themselves – this should decline as the pause handling improves (qualitatively, fewer users reporting “the bot didn’t catch what I said because I hesitated”).

Correction Feature Usage: Monitor how often users invoke the “Correct Me” feature. A higher usage indicates that engaged learners find it valuable. Aim for a significant percentage of sessions (e.g. 30%+) where users use this feature at least once, demonstrating that users want and use on-demand feedback.

Colloquial Suggestion Adoption: As mentioned, track if users implement suggested colloquial corrections in later messages. Success is a 15% increase in adoption of such suggestions (i.e., users naturally using a taught colloquial phrase later on), indicating effective learning.

User Satisfaction: Improved user sentiment regarding the bot’s intelligence and helpfulness. We expect more feedback highlighting that the bot is “smart” in understanding user hesitation and “helpful” in providing corrections. This contributes to overall positive reviews (supporting the target of 100+ positive feedback items about the bot being intelligent/helpful) and an uplift in NPS (+10 points) due to a more supportive experience.

UI/UX Enhancements and Polish

User Pain Points: Test users identified a number of usability issues and interface shortcomings that, while not core to language learning, affect the overall user experience:

Inflexible UI Language: The app interface and AI’s text outputs were not easily switchable between languages/scripts. Cantonese learners from Hong Kong/Taiwan prefer Traditional Chinese characters, whereas others might want Simplified or even an English interface. The lack of a quick toggle led to confusion (for instance, Cantonese speech yielding Simplified Chinese transcripts unexpectedly).

Coarse TTS Speed Control: The text-to-speech playback speed only had a few preset options (e.g. 1.0×, 1.1×, 1.2×). Users felt these jumps were too large – one mentioned that 1.1× was slightly slow and 1.2× slightly fast, wishing for a 1.15× option. The granularity was insufficient to match individual listening comfort.

Lack of Visual Feedback (Recording): In the prior version, when the user was speaking, there was no clear indicator of how much recording time was left. Users could not gauge if they needed to wrap up their speech. This was already known as a needed feature and testers reiterated its importance.

General UI Polish: Some feedback simply noted that the interface could be more polished or modern (“UI精进” – UI refinement requested). This likely refers to improving the visual design, layout, and overall professional feel of the app.

Proposed Solution: Make a series of UI/UX improvements to enhance usability and give the app a more professional polish:

Multi-Language Interface: Introduce a language selection option in the app settings for the UI and output text. Support at least three options: Simplified Chinese, Traditional Chinese, and English. When a user selects one, all interface elements (menus, buttons, prompts) appear in that language, and the AI’s text responses should align with the chosen script for Chinese. This ensures consistency (e.g., no mixing of simplified text when Traditional is desired).

Fine-Grained Speed Slider: Revise the TTS playback speed control to allow smaller increments. Instead of only 1.0 or 1.2, allow settings like 0.8, 0.9, 1.0, 1.1, 1.15, 1.2, 1.3, etc.. This can be implemented as a slider or stepper with 0.05 or 0.1 step values. Users can then fine-tune the speaking rate to their preference, improving comprehension and comfort when listening to Cantonese.

Recording Countdown Indicator: Implement a visual countdown timer for voice input duration. For example, if the maximum recording time per turn is (say) 60 seconds, show a diminishing ring or progress bar while the user is speaking. This gives users a sense of how long they can talk and encourages them to pace themselves. It also adds a professional touch to the voice interface.

Visual Refresh: Update the UI layout and styling for a cleaner, more modern look. This might include adjusting color schemes, fonts, or button styles to be more consistent and visually appealing. Also, refine interaction flows (for example, the transition from listening -> thinking -> speaking states could be smoother with clear icons or animations). While details aren’t specified in feedback, a general audit of the UI/UX should be done to address any rough edges (for instance, aligning elements, ensuring responsive design on different devices, etc.).

Key Functional Requirements:

Language Toggle in Settings: Provide a setting where the user can select UI language: “简体中文” (Simplified), “繁體中文” (Traditional), or “English.” Changing this should update all static text immediately. Also, ensure that when Chinese is selected, the AI output text uses the corresponding script (this ties into the earlier “Unified Script Display” requirement). Maintain separate localization files for each language to manage all interface text.

TTS Speed Control: Redesign the speed control UI component. If a slider is used, it should allow discrete steps (e.g., 0.05 or 0.1). Display the current speed value to two decimal places so users know their exact setting (for example, “1.15×”). If using buttons, include enough options to cover the range 0.8–1.3× at minimum. The chosen speed should persist between sessions.

Recording Timer: During voice recording, display a countdown timer or progress circle indicating the remaining time. For example, a circular outline around the microphone icon that slowly closes, or a numeric counter (60…59…58...). The timer should reset each time the user starts a new voice input. If feasible, allow up to the current max input length (adjustable if needed). The visual design of this timer should be subtle enough not to distract, but clear enough to be noticed at a glance.

UI Style Upgrade: Apply a consistent design language. Use professional-looking icons and ensure all text is easily readable (consider larger font or higher contrast for accessibility). Optimize the layout for different screen sizes (mobile, tablet). Conduct a UX review to streamline any confusing steps (for instance, clearly indicate when the app is listening vs. processing vs. speaking). Include volunteer testers in a beta of the new UI for feedback.

Quality Assurance: Before release, test the UI language switch thoroughly (all text should appear in the correct language, no missing translations). Test the speed control to confirm it actually changes TTS playback speed accurately at each step. Verify the recording timer behaves correctly and resets.

Success Metrics:

User Satisfaction & NPS: A smoother, more personalized UI is expected to raise overall satisfaction. Aim for an improvement of about +10 points in Net Promoter Score after these changes, driven in part by users finding the app more user-friendly and polished.

“Easy to Use” Feedback: Monitor app store reviews and user surveys for mentions of usability. We target at least 100+ new positive feedback entries highlighting that the app is “easy to use” or “user-friendly,” alongside praise for authenticity and intelligence. This will indicate the UI/UX improvements are resonating with the user base.

Feature Utilization: Check settings data to see how many users switch their UI language or adjust TTS speed (high usage would validate that these options are desired). For example, a successful rollout might see a large portion of Hong Kong-based users switching the interface to Traditional Chinese, or many users experimenting with custom TTS speeds.

Retention: Better UX often correlates with improved retention. Track the user retention rate (e.g. 7-day or 30-day retention) for an uptick after the update – our goal is that making the app more comfortable and tailored will contribute to a higher proportion of users continuing to use the app (this supports the overall engagement increase goal, like DAU/WAU improvement mentioned under Dual-Mode).