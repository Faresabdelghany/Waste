// The notifications vocabulary (O16 of #290), held to the shape every
// vocabulary module keeps (src/__tests__/vocabulary.ts).
import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("notifications", vocabulary, vocabulary.NOTIFICATIONS_VOCABULARIES, 2, ["BROADCAST_NOTICES"])
