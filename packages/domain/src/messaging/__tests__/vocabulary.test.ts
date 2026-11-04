// The messaging vocabulary (#291 C15), held to the shape every vocabulary
// module keeps (src/__tests__/vocabulary.ts).
import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("messaging", vocabulary, vocabulary.MESSAGING_VOCABULARIES, 5)
