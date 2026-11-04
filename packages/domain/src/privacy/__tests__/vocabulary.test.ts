// The privacy vocabulary (#291 C19), held to the shape every vocabulary module
// keeps (src/__tests__/vocabulary.ts).
import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("privacy", vocabulary, vocabulary.PRIVACY_VOCABULARIES, 1)
